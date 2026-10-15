import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MAX_SUBAGENT_DESCENDANTS = 64;
const directoryCache = new Map<string, { signature: string; rows: SubagentThreadRecord[] }>();
const telemetryCache = new Map<string, { signature: string; value: Awaited<ReturnType<typeof readSubagentTelemetry>>; lastTaskAt: string | null }>();

export interface SubagentThreadRecord {
  id: string;
  parentThreadId: string;
  name: string;
  model?: string;
  reasoningEffort?: string;
  updatedAt: string | null;
  createdAt?: string | null;
  runtimeHome: string;
}

export async function readSubagentTelemetry(filePath: string): Promise<{ state: "running" | "completed" | "failed" | "interrupted" | "unknown"; model?: string; reasoningEffort?: string }> {
  const result: Awaited<ReturnType<typeof readSubagentTelemetry>> = { state: "unknown" };
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    // Never fall back to reading the entire log when one tool writes a huge
    // single-line output. The directory needs metadata, not the tool payload.
    const windowSize = 128 * 1024;
    const start = Math.max(0, stat.size - windowSize);
    const tail = Buffer.alloc(Math.min(windowSize, stat.size));
    await handle.read(tail, 0, tail.length, start);
    const head = start ? Buffer.alloc(Math.min(windowSize, stat.size)) : null;
    if (head) await handle.read(head, 0, head.length, 0);
    const completeLines = (buffer: Buffer, partialStart: boolean) => {
      const value = buffer.toString("utf8");
      return (partialStart ? value.slice(value.indexOf("\n") + 1) : value).split("\n");
    };
    let foundTerminal = false;
    for (const { line, statusAllowed } of [
      ...(head ? completeLines(head, false).map(line => ({ line, statusAllowed: false })) : []),
      ...completeLines(tail, start > 0).map(line => ({ line, statusAllowed: true }))
    ]) {
      let record: { type?: string; payload?: Record<string, unknown> };
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record?.payload;
      if (!payload || typeof payload !== "object") continue;
      if (record.type === "turn_context") {
        if (typeof payload.model === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(payload.model)) result.model = payload.model;
        const effort = payload.reasoning_effort ?? payload.effort;
        if (typeof effort === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(effort)) result.reasoningEffort = effort;
      }
      if (record.type !== "event_msg" || !statusAllowed) continue;
      if (payload.type === "task_started") { result.state = "running"; foundTerminal = false; }
      if (payload.type === "task_complete") { result.state = "completed"; foundTerminal = true; }
      if (["turn_aborted", "task_interrupted"].includes(String(payload.type))) { result.state = "interrupted"; foundTerminal = true; }
      if (["turn_failed", "task_failed"].includes(String(payload.type))) { result.state = "failed"; foundTerminal = true; }
    }
    if (!foundTerminal && result.state === "running" && Date.now() - stat.mtimeMs >= 120_000) result.state = "unknown";
    return result;
  } finally { await handle.close(); }
}

interface RuntimeThreadRow {
  id?: unknown;
  source?: unknown;
  title?: unknown;
  name?: unknown;
  model?: unknown;
  reasoning_effort?: unknown;
  agent_nickname?: unknown;
  updated_at_ms?: unknown;
  updated_at?: unknown;
  created_at_ms?: unknown;
  created_at?: unknown;
}

function subagentParentId(sourceValue: unknown): string | null {
  if (typeof sourceValue !== "string") return null;
  try {
    const source = JSON.parse(sourceValue) as {
      subagent?: { thread_spawn?: { parent_thread_id?: unknown } };
    };
    const parentId = source?.subagent?.thread_spawn?.parent_thread_id;
    return typeof parentId === "string" && parentId ? parentId : null;
  } catch {
    return null;
  }
}

function updatedAtFromRow(row: RuntimeThreadRow): string | null {
  const millis = typeof row.updated_at_ms === "number" ? row.updated_at_ms
    : typeof row.updated_at === "number" ? row.updated_at * 1000 : null;
  if (millis !== null && Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString();
  return typeof row.updated_at === "string" && Number.isFinite(Date.parse(row.updated_at)) ? new Date(Date.parse(row.updated_at)).toISOString() : null;
}

function createdAtFromRow(row: RuntimeThreadRow): string | null {
  const millis = typeof row.created_at_ms === "number" ? row.created_at_ms
    : typeof row.created_at === "number" ? row.created_at * 1000 : null;
  if (millis !== null && Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString();
  return typeof row.created_at === "string" && Number.isFinite(Date.parse(row.created_at)) ? new Date(Date.parse(row.created_at)).toISOString() : null;
}

function threadRecord(row: RuntimeThreadRow, parentThreadId: string, runtimeHome: string): SubagentThreadRecord | null {
  if (typeof row.id !== "string" || !row.id || subagentParentId(row.source) !== parentThreadId) return null;
  // Code-mode tools refer to the canonical task path, not the generated nick.
  // Use that same identity for the transcript event, avatar, and child viewer.
  const source = JSON.parse(String(row.source)) as { subagent?: { thread_spawn?: { agent_path?: unknown } } };
  const name = [source.subagent?.thread_spawn?.agent_path, row.name, row.agent_nickname, row.title]
    .find((value) => typeof value === "string" && value.trim());
  const record: SubagentThreadRecord = {
    id: row.id,
    parentThreadId,
    name: typeof name === "string" ? name.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 256) : row.id,
    updatedAt: updatedAtFromRow(row),
    runtimeHome
  };
  const createdAt = createdAtFromRow(row);
  if (createdAt) record.createdAt = createdAt;
  if (typeof row.model === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(row.model)) record.model = row.model;
  if (typeof row.reasoning_effort === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(row.reasoning_effort)) record.reasoningEffort = row.reasoning_effort;
  return record;
}

function listFromRuntime(parentThreadId: string, runtimeHome: string, max: number): SubagentThreadRecord[] {
  const statePath = path.join(runtimeHome, "state_5.sqlite");
  if (!fs.existsSync(statePath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(statePath, { readOnly: true });
    const hasThreads = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
    if (!hasThreads) return [];
    const columns = new Set((db.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>).map((column) => column.name));
    if (!columns.has("id") || !columns.has("source")) return [];
    const parent = db.prepare("SELECT 1 AS present FROM threads WHERE id = ? LIMIT 1").get(parentThreadId);
    if (!parent) return [];
    const selected = ["id", "source", "title", "name", "model", "reasoning_effort", "agent_nickname", "updated_at_ms", "updated_at", "created_at_ms", "created_at"]
      .filter((column) => columns.has(column));
    const statement = db.prepare(`SELECT ${selected.map((column) => `"${column}"`).join(", ")} FROM threads WHERE json_valid(source) AND json_extract(source, '$.subagent.thread_spawn.parent_thread_id') = ? LIMIT ?`);
    const queue: Array<{ parentId: string; depth: number }> = [{ parentId: parentThreadId, depth: 0 }];
    const records: SubagentThreadRecord[] = [];
    const seen = new Set<string>([parentThreadId]);
    while (queue.length && records.length < max) {
      const current = queue.shift()!;
      const rows = statement.all(current.parentId, max - records.length) as RuntimeThreadRow[];
      for (const row of rows) {
        const child = threadRecord(row, current.parentId, runtimeHome);
        if (!child || seen.has(child.id)) continue;
        seen.add(child.id);
        records.push(child);
        queue.push({ parentId: child.id, depth: current.depth + 1 });
        if (records.length >= max) break;
      }
    }
    return records;
  } catch {
    // A missing, old, or temporarily busy runtime database must not make a
    // subagent relationship visible from another account's database.
    return [];
  } finally {
    db?.close();
  }
}

/** Read the parent/child metadata graph only from the explicitly configured
 * Codex account runtimes. A parent must exist in the same runtime database. */
export function listSubagentDescendants(parentThreadId: string, runtimeHomes: string[], max = MAX_SUBAGENT_DESCENDANTS): SubagentThreadRecord[] {
  const cleanParentId = parentThreadId.trim();
  const limit = Math.max(0, Math.min(MAX_SUBAGENT_DESCENDANTS, Math.floor(max)));
  if (!cleanParentId || !limit) return [];
  const byId = new Map<string, SubagentThreadRecord>();
  for (const runtimeHomeValue of runtimeHomes) {
    const runtimeHome = path.resolve(runtimeHomeValue);
    const records = listFromRuntime(cleanParentId, runtimeHome, limit - byId.size);
    for (const record of records) {
      const existing = byId.get(record.id);
      // Duplicate runtime snapshots are collapsed; prefer the newest row,
      // without merging relationships across databases.
      if (!existing || Date.parse(record.updatedAt ?? "") > Date.parse(existing.updatedAt ?? "")) byId.set(record.id, record);
    }
  }
  return [...byId.values()].slice(0, limit);
}

export type SubagentState = "running" | "waiting" | "dispatched" | "completed" | "failed" | "interrupted" | "unknown";
export interface SubagentDirectoryRow extends SubagentThreadRecord { state: SubagentState; createdAt?: string | null; lastTaskAt?: string | null }

async function findSessionFile(root: string, id: string): Promise<string | null> {
  const wanted = (name: string) => name === `${id}.jsonl` || name === `rollout-${id}.jsonl` || name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`);
  const walk = async (directory: string): Promise<string | null> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && wanted(entry.name)) return candidate;
      if (entry.isDirectory()) { const nested = await walk(candidate); if (nested) return nested; }
    }
    return null;
  };
  return walk(root);
}

async function lastTaskStartedAt(filePath: string): Promise<string | null> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat(), size = Math.min(stat.size, 256 * 1024), buffer = Buffer.alloc(size);
    if (size) await handle.read(buffer, 0, size, stat.size - size);
    const lines = buffer.toString("utf8").split("\n").slice(stat.size > size ? 1 : 0);
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const row = JSON.parse(lines[index]) as { type?: string; timestamp?: string; payload?: Record<string, unknown> };
        if (row.type !== "event_msg" || row.payload?.type !== "task_started") continue;
        const seconds = row.payload.started_at;
        if (typeof seconds === "number" && Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
        if (typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp))) return new Date(Date.parse(row.timestamp)).toISOString();
      } catch { /* incomplete or non-JSON line */ }
    }
  } finally { await handle.close(); }
  return null;
}

function uncappedFromRuntime(parentThreadId: string, runtimeHome: string): SubagentThreadRecord[] {
  const statePath = path.join(runtimeHome, "state_5.sqlite");
  try {
    const stat = fs.statSync(statePath), walPath = `${statePath}-wal`;
    let walSignature = "";
    try { const wal = fs.statSync(walPath); walSignature = `${wal.ino}:${wal.ctimeMs}:${wal.mtimeMs}:${wal.size}`; } catch { /* no WAL */ }
    const signature = `${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}|${walSignature}`, key = `${statePath}\0${parentThreadId}`;
    const cached = directoryCache.get(key);
    if (cached?.signature === signature) return cached.rows;
    const rows = listFromRuntime(parentThreadId, runtimeHome, Number.MAX_SAFE_INTEGER);
    directoryCache.set(key, { signature, rows });
    while (directoryCache.size > 128) directoryCache.delete(directoryCache.keys().next().value!);
    return rows;
  } catch { return []; }
}

/** Ancestry lookup is deliberately independent of the legacy 64-row helper. */
export function findSubagentDescendant(parentThreadId: string, childThreadId: string, runtimeHomes: string[]): SubagentThreadRecord | null {
  for (const home of runtimeHomes) {
    const found = uncappedFromRuntime(parentThreadId, path.resolve(home)).find(row => row.id === childThreadId);
    if (found) return found;
  }
  return null;
}

export async function readSubagentDirectoryPage(parentThreadId: string, runtimeHomes: string[], options: { view?: "all" | "active" | "history"; q?: string; cursor?: string; limit?: number; resolveSessionFile?: (id: string, root: string) => Promise<string | null> } = {}) {
  const view = options.view ?? "all", limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 40)));
  const all = new Map<string, SubagentThreadRecord>();
  for (const home of runtimeHomes) for (const row of uncappedFromRuntime(parentThreadId, path.resolve(home))) {
    const previous = all.get(row.id);
    if (!previous || Date.parse(row.updatedAt ?? "") > Date.parse(previous.updatedAt ?? "")) all.set(row.id, row);
  }
  const records = [...all.values()], enriched: SubagentDirectoryRow[] = new Array(records.length);
  let cursorIndex = 0;
  const worker = async () => {
    while (cursorIndex < records.length) {
      const index = cursorIndex++, record = records[index];
      const root = path.join(record.runtimeHome, "sessions");
      const file = await (options.resolveSessionFile ? options.resolveSessionFile(record.id, root) : findSessionFile(root, record.id));
    let telemetry: Awaited<ReturnType<typeof readSubagentTelemetry>> = { state: "unknown" };
    let lastTaskAt: string | null = null;
    if (file) try {
      const stat = await fs.promises.stat(file), signature = `${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`, cached = telemetryCache.get(file);
      if (cached?.signature === signature) {
        telemetry = cached.value; lastTaskAt = cached.lastTaskAt;
        if (telemetry.state === "running" && Date.now() - stat.mtimeMs >= 120_000) telemetry = { ...telemetry, state: "unknown" };
      }
      else {
        telemetry = await readSubagentTelemetry(file); lastTaskAt = await lastTaskStartedAt(file);
        telemetryCache.set(file, { signature, value: telemetry, lastTaskAt });
        while (telemetryCache.size > 4096) telemetryCache.delete(telemetryCache.keys().next().value!);
      }
    } catch { /* state remains unknown */ }
      enriched[index] = { ...record, createdAt: record.createdAt ?? null, lastTaskAt, state: telemetry.state, ...(telemetry.model ?? record.model ? { model: telemetry.model ?? record.model } : {}),
      ...(telemetry.reasoningEffort ?? record.reasoningEffort ? { reasoningEffort: telemetry.reasoningEffort ?? record.reasoningEffort } : {}) } as SubagentDirectoryRow;
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, records.length) }, worker));
  const active = (row: SubagentDirectoryRow) => ["running", "waiting", "dispatched"].includes(row.state);
  const activeCount = enriched.filter(active).length, historyCount = enriched.length - activeCount;
  const unknownCount = enriched.filter(row => row.state === "unknown").length;
  let filtered = enriched.filter(row => view === "all" || (view === "active" ? active(row) : !active(row)));
  const normalizedQ = options.q?.trim().toLocaleLowerCase() ?? "";
  if (normalizedQ) filtered = filtered.filter(row => `${row.id} ${row.name} ${row.model ?? ""}`.toLocaleLowerCase().includes(normalizedQ));
  const compare = (a: SubagentDirectoryRow, b: SubagentDirectoryRow) => (view === "all" ? Number(active(b)) - Number(active(a)) : 0)
    || (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0) || a.id.localeCompare(b.id);
  filtered.sort(compare);
  const matchedCount = filtered.length;
  if (options.cursor) {
    let cursor: { v: number; view: string; q: string; active: boolean; updatedAt: string | null; id: string };
    try {
      cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (cursor.v !== 1 || cursor.view !== view || cursor.q !== normalizedQ || typeof cursor.id !== "string" || !cursor.id
        || typeof cursor.active !== "boolean" || !(cursor.updatedAt === null || typeof cursor.updatedAt === "string" && Number.isFinite(Date.parse(cursor.updatedAt)))) throw 0;
    }
    catch { throw new Error("Invalid subagent cursor."); }
    const boundary = { id: cursor.id, updatedAt: cursor.updatedAt, state: cursor.active ? "running" : "unknown" } as SubagentDirectoryRow;
    filtered = filtered.filter(row => compare(row, boundary) > 0);
  }
  const rows = filtered.slice(0, limit), hasMore = filtered.length > limit, last = rows.at(-1);
  const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ v: 1, view, q: normalizedQ, active: active(last), updatedAt: last.updatedAt, id: last.id })).toString("base64url") : null;
  return { data: rows.map(({ runtimeHome: _runtimeHome, ...row }) => row), page: { total: enriched.length, matchedCount, activeCount, historyCount, unknownCount, hasMore, nextCursor } };
}

export function configuredSubagentRuntimeHomes(parentThreadId?: string): string[] {
  const configuredFile = process.env.CODEX_WEB_ACCOUNT_POOL_FILE?.trim();
  if (configuredFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configuredFile, "utf8")) as { accounts?: unknown; stateFile?: unknown };
      const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      const homes = accounts.flatMap((account) => {
        if (!account || typeof account !== "object") return [];
        const home = (account as { codexHome?: unknown }).codexHome;
        const id = (account as { id?: unknown }).id;
        return typeof id === "string" && typeof home === "string" && path.isAbsolute(home)
          ? [{ id, home: path.resolve(home) }]
          : [];
      });
      if (parentThreadId && typeof parsed.stateFile === "string" && parsed.stateFile) {
        const stateFile = path.resolve(path.dirname(configuredFile), parsed.stateFile);
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { threadAccounts?: unknown };
          const threadAccounts = state.threadAccounts && typeof state.threadAccounts === "object"
            ? state.threadAccounts as Record<string, unknown>
            : {};
          const accountId = threadAccounts[parentThreadId];
          if (typeof accountId === "string") {
            const home = homes.find((account) => account.id === accountId)?.home;
            return home ? [home] : [];
          }
        } catch {
          // Older installations may not have a thread-to-account pin map.
        }
      }
      return [...new Set(homes.map((account) => account.home))];
    } catch {
      return [];
    }
  }
  const codexHome = process.env.CODEX_HOME?.trim();
  return codexHome && path.isAbsolute(codexHome) ? [path.resolve(codexHome)] : [];
}
