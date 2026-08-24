import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serverConfig } from "./config.js";
import { readThreadFromJsonl } from "./threadFallback.js";

type JsonRecord = Record<string, unknown>;

interface FileState {
  threadId: string;
  filePath: string;
  inode: number;
  size: number;
  mtimeMs: number;
  indexedOffset: number;
  currentTurnId: string | null;
  metadataLine: string | null;
}

interface IndexedRecord {
  ordinal: number;
  recordId: string;
  turnId: string;
  startOffset: number;
  endOffset: number;
  searchText: string;
}

export interface IndexedSearchMatch {
  threadId: string;
  turnId: string;
  itemId: string;
  query: string;
  snippet: string;
  cursor: string;
  ordinal: number;
}

const indexPath = process.env.CODEX_THREAD_INDEX_DB
  ?? path.join(serverConfig.dataDir, "thread-events.sqlite");
await fs.mkdir(path.dirname(indexPath), { recursive: true });
const db = new DatabaseSync(indexPath);
db.exec(`
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  CREATE TABLE IF NOT EXISTS thread_files (
    thread_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    inode INTEGER NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    indexed_offset INTEGER NOT NULL,
    current_turn_id TEXT,
    metadata_line TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS thread_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER,
    PRIMARY KEY (thread_id, turn_id)
  );
  CREATE TABLE IF NOT EXISTS thread_records (
    thread_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    record_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    call_id TEXT,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    search_text TEXT NOT NULL,
    PRIMARY KEY (thread_id, ordinal),
    UNIQUE (thread_id, record_id)
  );
  CREATE INDEX IF NOT EXISTS thread_records_call_idx ON thread_records(thread_id, call_id);
  CREATE INDEX IF NOT EXISTS thread_records_turn_idx ON thread_records(thread_id, turn_id, ordinal);
  CREATE VIRTUAL TABLE IF NOT EXISTS thread_records_fts USING fts5(
    search_text,
    thread_id UNINDEXED,
    record_id UNINDEXED,
    tokenize='trigram'
  );
`);

const updateLocks = new Map<string, Promise<void>>();
let writeQueue: Promise<void> = Promise.resolve();

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    const record = asRecord(entry);
    return typeof record.text === "string"
      ? record.text
      : typeof record.content === "string"
        ? record.content
        : "";
  }).filter(Boolean).join("\n");
}

function boundedText(value: unknown, maxChars = 64 * 1024): string {
  let text = "";
  if (typeof value === "string") text = value;
  else if (value !== undefined && value !== null) {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  return text.replace(/\u0000/g, "").slice(0, maxChars);
}

function messageIsHidden(payload: JsonRecord): boolean {
  if (payload.role === "developer") return true;
  if (payload.role !== "user") return false;
  const text = textFromContent(payload.content).trim();
  return text.startsWith("<environment_context>")
    || text.startsWith("<recommended_plugins>")
    || text.startsWith("<permissions instructions>")
    || text.startsWith("<app-context>");
}

function turnIdFromPayload(payload: JsonRecord, fallback: string | null): string | null {
  if (typeof payload.turn_id === "string" && payload.turn_id) return payload.turn_id;
  const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
  return typeof metadata.turn_id === "string" && metadata.turn_id ? metadata.turn_id : fallback;
}

function recordDescriptor(payload: JsonRecord): { kind: string; recordId: string | null; callId: string | null; searchText: string } | null {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "message") {
    if (messageIsHidden(payload)) return null;
    const text = textFromContent(payload.content).trim();
    if (!text) return null;
    return {
      kind: payload.role === "user" ? "user" : "agent",
      recordId: typeof payload.id === "string" ? payload.id : null,
      callId: null,
      searchText: text
    };
  }
  if (type === "reasoning") {
    const text = Array.isArray(payload.summary) ? payload.summary.map(boundedText).join("\n") : "";
    if (!text.trim()) return null;
    return { kind: "reasoning", recordId: typeof payload.id === "string" ? payload.id : null, callId: null, searchText: text };
  }
  const isToolCall = type === "function_call" || type === "custom_tool_call" || type === "tool_call"
    || ((typeof payload.name === "string" || typeof payload.tool === "string") && ("arguments" in payload || "input" in payload || "params" in payload));
  if (isToolCall) {
    const recordId = typeof payload.id === "string" ? payload.id : null;
    const callId = typeof payload.call_id === "string"
      ? payload.call_id
      : typeof payload.tool_call_id === "string"
        ? payload.tool_call_id
        : recordId;
    return {
      kind: "tool",
      recordId,
      callId,
      searchText: [boundedText(payload.name ?? payload.tool, 1024), boundedText(payload.arguments ?? payload.input ?? payload.params, 8 * 1024)].filter(Boolean).join("\n")
    };
  }
  return null;
}

function toolOutputDescriptor(payload: JsonRecord): { callId: string; searchText: string } | null {
  const type = typeof payload.type === "string" ? payload.type : "";
  const isOutput = type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_call_output"
    || (("output" in payload || "result" in payload) && ("call_id" in payload || "tool_call_id" in payload));
  if (!isOutput) return null;
  const callId = typeof payload.call_id === "string"
    ? payload.call_id
    : typeof payload.tool_call_id === "string"
      ? payload.tool_call_id
      : "";
  return callId ? { callId, searchText: boundedText(payload.output ?? payload.result ?? payload.content, 4 * 1024) } : null;
}

function fileState(threadId: string): FileState | null {
  const row = db.prepare(`
    SELECT thread_id, file_path, inode, size, mtime_ms, indexed_offset, current_turn_id, metadata_line
    FROM thread_files WHERE thread_id = ?
  `).get(threadId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    threadId: String(row.thread_id),
    filePath: String(row.file_path),
    inode: Number(row.inode),
    size: Number(row.size),
    mtimeMs: Number(row.mtime_ms),
    indexedOffset: Number(row.indexed_offset),
    currentTurnId: typeof row.current_turn_id === "string" ? row.current_turn_id : null,
    metadataLine: typeof row.metadata_line === "string" ? row.metadata_line : null
  };
}

function resetThread(threadId: string): void {
  db.prepare(`
    DELETE FROM thread_records_fts
    WHERE rowid IN (SELECT rowid FROM thread_records WHERE thread_id = ?)
  `).run(threadId);
  db.prepare("DELETE FROM thread_records WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM thread_turns WHERE thread_id = ?").run(threadId);
  db.prepare("DELETE FROM thread_files WHERE thread_id = ?").run(threadId);
}

function nextOrdinal(threadId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(ordinal), 0) AS value FROM thread_records WHERE thread_id = ?").get(threadId) as { value?: number };
  return Number(row?.value ?? 0) + 1;
}

function insertFts(rowid: number | bigint, threadId: string, recordId: string, searchText: string): void {
  db.prepare("INSERT INTO thread_records_fts(rowid, search_text, thread_id, record_id) VALUES (?, ?, ?, ?)")
    .run(rowid, searchText, threadId, recordId);
}

async function indexedRecordBoundaryMatches(filePath: string, threadId: string): Promise<boolean> {
  const row = db.prepare(`
    SELECT start_offset FROM thread_records
    WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1
  `).get(threadId) as { start_offset?: number } | undefined;
  if (row?.start_offset === undefined) return true;
  const startOffset = Number(row.start_offset);
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) return false;
  const handle = await fs.open(filePath, "r");
  try {
    if (startOffset === 0) {
      const current = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(current, 0, 1, 0);
      return bytesRead === 1 && current[0] === 123;
    }
    const boundary = Buffer.allocUnsafe(2);
    const { bytesRead } = await handle.read(boundary, 0, 2, startOffset - 1);
    return bytesRead === 2 && boundary[0] === 10 && boundary[1] === 123;
  } finally {
    await handle.close();
  }
}

async function updateThreadIndex(filePath: string, threadId: string): Promise<void> {
  const stat = await fs.stat(filePath);
  let state = fileState(threadId);
  const boundaryMatches = !state || await indexedRecordBoundaryMatches(filePath, threadId);
  const mustReset = Boolean(state && (
    state.filePath !== filePath
    || state.inode !== Number(stat.ino)
    || stat.size < state.indexedOffset
    || (stat.size === state.size && stat.mtimeMs !== state.mtimeMs)
    || !boundaryMatches
  ));
  if (mustReset) state = null;
  if (state && state.size === stat.size && state.mtimeMs === stat.mtimeMs) return;

  let currentTurnId = state?.currentTurnId ?? null;
  let metadataLine = state?.metadataLine ?? null;
  let ordinal = mustReset ? 1 : nextOrdinal(threadId);
  let lineStart = state?.indexedOffset ?? 0;
  let pending = Buffer.alloc(0);
  let operations: Array<() => void> = [];
  let resetPending = mustReset;

  const flushIndexBatch = (indexedOffset: number, complete: boolean): void => {
    if (!operations.length && !resetPending && !complete) return;
    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      if (resetPending) resetThread(threadId);
      for (const operation of operations) operation();
      db.prepare(`
        INSERT INTO thread_files(thread_id, file_path, inode, size, mtime_ms, indexed_offset, current_turn_id, metadata_line, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          file_path=excluded.file_path, inode=excluded.inode, size=excluded.size, mtime_ms=excluded.mtime_ms,
          indexed_offset=excluded.indexed_offset, current_turn_id=excluded.current_turn_id,
          metadata_line=excluded.metadata_line, updated_at=excluded.updated_at
      `).run(
        threadId,
        filePath,
        Number(stat.ino),
        complete ? stat.size : indexedOffset,
        stat.mtimeMs,
        indexedOffset,
        currentTurnId,
        metadataLine,
        Date.now()
      );
      db.exec("COMMIT");
      transactionStarted = false;
      resetPending = false;
      operations = [];
    } catch (error) {
      if (transactionStarted && db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  };

  // Parse the JSONL before opening a transaction. File streaming is asynchronous;
  // keeping BEGIN open across `await` lets another request enter the same sqlite
  // connection and caused intermittent "transaction within a transaction" 502s.
  for await (const chunkValue of createReadStream(filePath, { start: lineStart })) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      const newlineIndex = pending.indexOf(10);
      if (newlineIndex < 0) break;
      const lineBuffer = pending.subarray(0, newlineIndex);
      const lineEnd = lineStart + newlineIndex + 1;
      const line = lineBuffer.toString("utf8").replace(/\r$/, "");
      pending = pending.subarray(newlineIndex + 1);
      if (line.trim()) {
        let record: JsonRecord | null = null;
        try { record = asRecord(JSON.parse(line)); } catch { record = null; }
        if (record) {
          const payload = asRecord(record.payload);
          if (record.type === "session_meta") metadataLine = line;
          if (record.type === "turn_context" && typeof payload.turn_id === "string") {
            currentTurnId = payload.turn_id;
            const turnId = currentTurnId;
            const startOffset = lineStart;
            operations.push(() => {
              db.prepare(`
                INSERT INTO thread_turns(thread_id, turn_id, start_offset, end_offset) VALUES (?, ?, ?, NULL)
                ON CONFLICT(thread_id, turn_id) DO NOTHING
              `).run(threadId, turnId, startOffset);
            });
          }
          if (record.type === "event_msg") {
            if (payload.type === "task_started" && typeof payload.turn_id === "string") {
              currentTurnId = payload.turn_id;
              const turnId = currentTurnId;
              const startOffset = lineStart;
              operations.push(() => {
                db.prepare(`
                  INSERT INTO thread_turns(thread_id, turn_id, start_offset, end_offset) VALUES (?, ?, ?, NULL)
                  ON CONFLICT(thread_id, turn_id) DO NOTHING
                `).run(threadId, turnId, startOffset);
              });
            } else if (payload.type === "task_complete" && typeof payload.turn_id === "string") {
              const turnId = payload.turn_id;
              operations.push(() => {
                db.prepare("UPDATE thread_turns SET end_offset = ? WHERE thread_id = ? AND turn_id = ?")
                  .run(lineEnd, threadId, turnId);
              });
            } else if (payload.type === "image_generation_end" && currentTurnId) {
              const recordId = `jsonl-${lineStart}`;
              const turnId = currentTurnId;
              const startOffset = lineStart;
              const searchText = [boundedText(payload.revised_prompt), boundedText(payload.saved_path)].filter(Boolean).join("\n");
              operations.push(() => {
                const result = db.prepare(`
                  INSERT OR IGNORE INTO thread_records(thread_id, ordinal, record_id, turn_id, kind, call_id, start_offset, end_offset, search_text)
                  VALUES (?, ?, ?, ?, 'image', NULL, ?, ?, ?)
                `).run(threadId, ordinal, recordId, turnId, startOffset, lineEnd, searchText);
                if (Number(result.changes) > 0) { insertFts(result.lastInsertRowid, threadId, recordId, searchText); ordinal += 1; }
              });
            }
          }
          if (record.type === "response_item") {
            const turnId = turnIdFromPayload(payload, currentTurnId);
            if (turnId) {
              const output = toolOutputDescriptor(payload);
              if (output) {
                const startOffset = lineStart;
                operations.push(() => {
                  const matching = db.prepare(`
                    SELECT rowid, record_id, search_text FROM thread_records
                    WHERE thread_id = ? AND call_id = ? ORDER BY ordinal DESC LIMIT 1
                  `).get(threadId, output.callId) as { rowid?: number; record_id?: string; search_text?: string } | undefined;
                  if (matching?.rowid) {
                    const searchText = [matching.search_text ?? "", output.searchText].filter(Boolean).join("\n").slice(0, 12 * 1024);
                    db.prepare("UPDATE thread_records SET end_offset = ?, search_text = ? WHERE rowid = ?")
                      .run(lineEnd, searchText, matching.rowid);
                    db.prepare("DELETE FROM thread_records_fts WHERE rowid = ?").run(matching.rowid);
                    insertFts(matching.rowid, threadId, matching.record_id ?? output.callId, searchText);
                  } else {
                    const recordId = `${output.callId}-output-${startOffset}`;
                    const result = db.prepare(`
                      INSERT OR IGNORE INTO thread_records(thread_id, ordinal, record_id, turn_id, kind, call_id, start_offset, end_offset, search_text)
                      VALUES (?, ?, ?, ?, 'tool-output', ?, ?, ?, ?)
                    `).run(threadId, ordinal, recordId, turnId, output.callId, startOffset, lineEnd, output.searchText);
                    if (Number(result.changes) > 0) { insertFts(result.lastInsertRowid, threadId, recordId, output.searchText); ordinal += 1; }
                  }
                });
              } else {
                const descriptor = recordDescriptor(payload);
                if (descriptor) {
                  const startOffset = lineStart;
                  const recordId = descriptor.recordId ?? descriptor.callId ?? `jsonl-${startOffset}`;
                  operations.push(() => {
                    const result = db.prepare(`
                      INSERT OR IGNORE INTO thread_records(thread_id, ordinal, record_id, turn_id, kind, call_id, start_offset, end_offset, search_text)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `).run(threadId, ordinal, recordId, turnId, descriptor.kind, descriptor.callId, startOffset, lineEnd, descriptor.searchText);
                    if (Number(result.changes) > 0) { insertFts(result.lastInsertRowid, threadId, recordId, descriptor.searchText); ordinal += 1; }
                  });
                }
              }
            }
          }
        }
      }
      lineStart = lineEnd;
      if (operations.length >= 256) flushIndexBatch(lineStart, false);
    }
  }
  flushIndexBatch(lineStart, true);
}

export function warmThreadIndex(filePath: string, threadId: string): Promise<void> {
  const existing = updateLocks.get(threadId);
  if (existing) return existing;
  const update = writeQueue.then(async () => {
    const state = fileState(threadId);
    if (state) {
      const stat = await fs.stat(filePath);
      if (
        state.filePath === filePath
        && state.inode === Number(stat.ino)
        && state.size === stat.size
        && state.indexedOffset === stat.size
        && state.mtimeMs === stat.mtimeMs
      ) {
        return;
      }
    }
    await updateThreadIndex(filePath, threadId);
  });
  writeQueue = update.catch(() => undefined);
  void update.finally(() => updateLocks.delete(threadId)).catch(() => undefined);
  updateLocks.set(threadId, update);
  return update;
}

function encodeCursor(threadId: string, ordinal: number): string {
  return Buffer.from(JSON.stringify({ v: 1, t: threadId, o: ordinal })).toString("base64url");
}

function decodeCursor(cursor: string | undefined, threadId: string): number | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; t?: unknown; o?: unknown };
    return parsed.v === 1 && parsed.t === threadId && Number.isInteger(parsed.o) && Number(parsed.o) > 0 ? Number(parsed.o) : null;
  } catch {
    return null;
  }
}

export async function readIndexedThreadPage(
  filePath: string,
  threadId: string,
  options: { cursor?: string; before?: number; limit: number; backgroundRefresh?: boolean }
) {
  const state = fileState(threadId);
  const boundaryMatches = !state || await indexedRecordBoundaryMatches(filePath, threadId);
  if (options.backgroundRefresh && state && boundaryMatches) {
    const existingUpdate = updateLocks.get(threadId);
    if (existingUpdate) await existingUpdate;
    else void warmThreadIndex(filePath, threadId).catch(() => undefined);
  } else {
    await warmThreadIndex(filePath, threadId);
  }
  const totalRow = db.prepare("SELECT COUNT(*) AS value, COALESCE(MAX(ordinal), 0) AS max_ordinal FROM thread_records WHERE thread_id = ?")
    .get(threadId) as { value?: number; max_ordinal?: number };
  const totalItems = Number(totalRow.value ?? 0);
  const maxOrdinal = Number(totalRow.max_ordinal ?? 0);
  if (!totalItems) {
    const parsed = await readThreadFromJsonl(filePath, threadId);
    return {
      thread: parsed.thread,
      history: { totalItems: 0, returnedItems: 0, before: 0, nextBefore: 0, hasOlder: false, nextCursor: null, indexState: "fresh" as const }
    };
  }
  const legacyBefore = Math.max(0, Math.floor(options.before ?? 0));
  const cursorOrdinal = decodeCursor(options.cursor, threadId);
  const upperExclusive = cursorOrdinal ?? Math.max(1, maxOrdinal - legacyBefore + 1);
  const rows = (db.prepare(`
    SELECT ordinal, record_id, turn_id, start_offset, end_offset, search_text
    FROM thread_records WHERE thread_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?
  `).all(threadId, upperExclusive, Math.max(1, options.limit)) as Array<Record<string, unknown>>)
    .map((row): IndexedRecord => ({
      ordinal: Number(row.ordinal), recordId: String(row.record_id), turnId: String(row.turn_id),
      startOffset: Number(row.start_offset), endOffset: Number(row.end_offset), searchText: String(row.search_text ?? "")
    })).reverse();
  if (!rows.length) {
    const parsed = await readThreadFromJsonl(filePath, threadId);
    return {
      thread: { ...parsed.thread, turns: [] },
      history: { totalItems, returnedItems: 0, before: totalItems, nextBefore: totalItems, hasOlder: false, nextCursor: null, indexState: "fresh" as const }
    };
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  const nextInSameTurn = db.prepare(`
    SELECT start_offset FROM thread_records
    WHERE thread_id = ? AND turn_id = ? AND ordinal > ? ORDER BY ordinal ASC LIMIT 1
  `).get(threadId, last.turnId, last.ordinal) as { start_offset?: number } | undefined;
  const turnEnd = nextInSameTurn
    ? undefined
    : db.prepare("SELECT end_offset FROM thread_turns WHERE thread_id = ? AND turn_id = ?")
      .get(threadId, last.turnId) as { end_offset?: number } | undefined;
  const parsed = await readThreadFromJsonl(filePath, threadId, undefined, {
    startOffset: first.startOffset,
    endOffset: Math.max(last.endOffset, Number(turnEnd?.end_offset ?? 0)),
    syntheticTurnId: first.turnId
  });
  const hasOlder = first.ordinal > 1;
  return {
    thread: parsed.thread,
    history: {
      totalItems,
      returnedItems: rows.length,
      before: Math.max(0, totalItems - last.ordinal),
      nextBefore: Math.max(0, totalItems - first.ordinal + 1),
      hasOlder,
      nextCursor: hasOlder ? encodeCursor(threadId, first.ordinal) : null,
      indexState: "fresh" as const
    }
  };
}

function snippet(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const index = normalized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index < 0 ? 0 : index - 55);
  const end = Math.min(normalized.length, (index < 0 ? 0 : index) + query.length + 90);
  return `${start > 0 ? "..." : ""}${normalized.slice(start, end)}${end < normalized.length ? "..." : ""}`;
}

export function locateIndexedThreadItem(threadId: string, itemId: string) {
  const row = db.prepare("SELECT ordinal, turn_id FROM thread_records WHERE thread_id = ? AND record_id = ?")
    .get(threadId, itemId) as { ordinal?: number; turn_id?: string } | undefined;
  return row?.ordinal ? { ordinal: Number(row.ordinal), turnId: String(row.turn_id), cursor: encodeCursor(threadId, Number(row.ordinal) + 1) } : null;
}

export async function readIndexedThreadItem(filePath: string, threadId: string, itemId: string): Promise<JsonRecord | null> {
  await warmThreadIndex(filePath, threadId);
  const row = db.prepare(`
    SELECT turn_id, start_offset, end_offset FROM thread_records
    WHERE thread_id = ? AND record_id = ? LIMIT 1
  `).get(threadId, itemId) as { turn_id?: string; start_offset?: number; end_offset?: number } | undefined;
  if (!row?.turn_id || row.start_offset === undefined || row.end_offset === undefined) return null;
  const parsed = await readThreadFromJsonl(filePath, threadId, undefined, {
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    syntheticTurnId: String(row.turn_id)
  });
  const thread = parsed.thread as JsonRecord;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turnValue of turns) {
    const turn = turnValue as JsonRecord;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const item = items.find((value) => String((value as JsonRecord).id ?? "") === itemId);
    if (item && typeof item === "object") return item as JsonRecord;
  }
  return null;
}

export async function searchIndexedThreads(
  targets: Array<{ threadId: string; filePath: string }>,
  query: string,
  limit = 50
): Promise<IndexedSearchMatch[]> {
  let next = 0;
  const workers = Array.from({ length: Math.min(3, targets.length) }, async () => {
    for (;;) {
      const target = targets[next++];
      if (!target) return;
      await warmThreadIndex(target.filePath, target.threadId);
    }
  });
  await Promise.all(workers);
  const matches: IndexedSearchMatch[] = [];
  for (let start = 0; start < targets.length && matches.length < limit; start += 150) {
    const ids = targets.slice(start, start + 150).map((target) => target.threadId);
    if (!ids.length) continue;
    const placeholders = ids.map(() => "?").join(",");
    const rows = query.length >= 3
      ? db.prepare(`
          SELECT r.thread_id, r.turn_id, r.record_id, r.ordinal, r.search_text
          FROM thread_records_fts f JOIN thread_records r ON r.rowid = f.rowid
          WHERE f.search_text MATCH ? AND r.kind IN ('user', 'agent') AND r.thread_id IN (${placeholders})
          ORDER BY r.ordinal DESC LIMIT ?
        `).all(`"${query.replace(/"/g, '""')}"`, ...ids, limit - matches.length)
      : db.prepare(`
          SELECT thread_id, turn_id, record_id, ordinal, search_text FROM thread_records
          WHERE kind IN ('user', 'agent') AND search_text LIKE ? AND thread_id IN (${placeholders})
          ORDER BY ordinal DESC LIMIT ?
        `).all(`%${query}%`, ...ids, limit - matches.length);
    for (const value of rows as Array<Record<string, unknown>>) {
      const threadId = String(value.thread_id);
      const ordinal = Number(value.ordinal);
      matches.push({
        threadId,
        turnId: String(value.turn_id),
        itemId: String(value.record_id),
        query,
        snippet: snippet(String(value.search_text ?? ""), query),
        cursor: encodeCursor(threadId, ordinal + 1),
        ordinal
      });
    }
  }
  return matches.slice(0, limit);
}
