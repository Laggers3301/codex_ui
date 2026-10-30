import fs from "node:fs/promises";
import { createReadStream, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";
import { accountHistoryRoots } from "./sessionReadRoots.js";
import { isInternalUserMessageText } from "./internalUserMessage.js";
import { AppError } from "./appErrors.js";
import {readableRolloutPath, rolloutStat,openReadableRollout,rolloutReadStream,readRolloutText,rolloutLines,MAX_FULL_HISTORY_BYTES,HistoryMemoryLimitError} from './rolloutStorage.js';

type JsonObject = Record<string, unknown>;

export interface ThreadHistoryPage {
  totalItems: number;
  returnedItems: number;
  before: number;
  nextBefore: number;
  hasOlder: boolean;
}

interface JsonlRecord {
  timestamp?: string;
  type?: string;
  payload?: JsonObject;
}

interface FallbackTurn {
  id: string;
  items: JsonObject[];
  itemsView: string;
  status: string;
  error: unknown;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

function recordFromUnknown(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

const codexSessionsRoot = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
let configuredAccountHistoryRoots: string[] = [];
if (process.env.CODEX_WEB_ACCOUNT_POOL_FILE) {
  try { configuredAccountHistoryRoots = accountHistoryRoots(JSON.parse(readFileSync(process.env.CODEX_WEB_ACCOUNT_POOL_FILE, "utf8"))); }
  catch { /* Keep the existing explicit roots if pool configuration is unavailable. */ }
}
const configuredCodexSessionRoots = [...new Set([
  codexSessionsRoot,
  ...configuredAccountHistoryRoots,
  ...(process.env.CODEX_WEB_CODEX_SESSION_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
].map((entry) => path.resolve(entry)))];
const sessionPathIndexTtlMs = 60_000;
export function threadHistoryRuntimeHomes(): string[] {
  return [...new Set(configuredCodexSessionRoots.map(root=>path.dirname(root)))];
}
const cachedSessionPathIndexes = new Map<string, { expiresAt: number; paths: Map<string, string[]> }>();
const buildingSessionPathIndexes = new Map<string, Promise<Map<string, string[]>>>();

function secondsFromIso(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null;
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const value = part as { text?: unknown };
      return typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    return null;
  }
}

function commandTextFromArguments(argumentsJson: unknown): string {
  const args = parseJsonObject(argumentsJson);
  if (!args) {
    return "";
  }
  if (typeof args.cmd === "string") {
    return args.cmd;
  }
  if (Array.isArray(args.command)) {
    return args.command.map(String).join(" ");
  }
  return JSON.stringify(args, null, 2);
}

function toolInputText(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (input === null || input === undefined) {
    return "";
  }
  return JSON.stringify(input, null, 2);
}

function toolOutputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  const content = textFromContent(output);
  if (content.trim()) {
    return content;
  }
  if (output === null || output === undefined) {
    return "";
  }
  return JSON.stringify(output, null, 2);
}

function normalizedSearchTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function textMatchesSearch(text: string, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const normalizedText = text.toLowerCase();
  return normalizedText.includes(normalizedQuery) || normalizedSearchTerms(normalizedQuery).every((term) => normalizedText.includes(term));
}

function searchTextFromPayload(record: JsonlRecord): string {
  const payload = record.payload ?? {};
  if (record.type === "response_item") {
    if (payload.type === "message") {
      return shouldSkipMessage(payload) ? "" : textFromContent(payload.content);
    }
    if (payload.type === "function_call") {
      return `${String(payload.name ?? "")}\n${commandTextFromArguments(payload.arguments)}`;
    }
    if (payload.type === "custom_tool_call") {
      return `${String(payload.name ?? "")}\n${toolInputText(payload.input)}`;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      return toolOutputText(payload.output);
    }
    if (payload.type === "reasoning" && Array.isArray(payload.summary)) {
      return payload.summary.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
    }
  }
  if (record.type === "event_msg") {
    if (payload.type === "user_message" && typeof payload.message === "string") {
      const message = payload.message.trim();
      return isInternalUserMessageText(message) ? "" : message;
    }
    if (payload.type === "image_generation_end") {
      return `${typeof payload.revised_prompt === "string" ? payload.revised_prompt : ""}\n${typeof payload.saved_path === "string" ? payload.saved_path : ""}`;
    }
  }
  return "";
}

function getTurnId(payload: JsonObject, currentTurnId: string | null): string | null {
  const metadata = payload.internal_chat_message_metadata_passthrough;
  if (metadata && typeof metadata === "object" && "turn_id" in metadata) {
    const turnId = (metadata as { turn_id?: unknown }).turn_id;
    if (typeof turnId === "string" && turnId) {
      return turnId;
    }
  }
  return currentTurnId;
}

function shouldSkipMessage(payload: JsonObject): boolean {
  if (payload.role === "developer") {
    return true;
  }
  const text = textFromContent(payload.content).trim();
  if (payload.role !== "user") {
    return false;
  }
  return isInternalUserMessageText(text);
}

function sessionMetadataMatchesThread(metadata: JsonObject, threadId: string): boolean {
  return metadata.id === threadId || metadata.session_id === threadId;
}

function preferredSessionMetadata(current: JsonObject | null, candidate: JsonObject, threadId: string): JsonObject {
  if (!current || (!sessionMetadataMatchesThread(current, threadId) && sessionMetadataMatchesThread(candidate, threadId))) {
    return candidate;
  }
  return current;
}

function appendResponseItem(turn: FallbackTurn, payload: JsonObject, nextId: () => string): void {
  const itemType = payload.type;

  if (itemType === "message") {
    if (shouldSkipMessage(payload)) {
      return;
    }
    const text = textFromContent(payload.content);
    if (!text.trim()) {
      return;
    }
    const id = typeof payload.id === "string" ? payload.id : nextId();
    if (payload.role === "assistant") {
      turn.items.push({
        type: "agentMessage",
        id,
        text,
        phase: payload.phase
      });
      return;
    }
    if (payload.role === "user") {
      turn.items.push({
        type: "userMessage",
        id,
        content: [{ type: "text", text, text_elements: [] }]
      });
    }
    return;
  }

  if (itemType === "function_call" || itemType === "custom_tool_call") {
    const id = typeof payload.id === "string" ? payload.id : nextId();
    const command = itemType === "custom_tool_call" ? toolInputText(payload.input) : commandTextFromArguments(payload.arguments);
    turn.items.push({
      type: "toolCall",
      id,
      callId: payload.call_id,
      tool: payload.name,
      command: command || undefined,
      text: command || String(payload.name ?? "tool call")
    });
    return;
  }

  if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : nextId();
    const output = toolOutputText(payload.output);
    turn.items.push({
      type: "toolCallOutput",
      id: typeof payload.id === "string" ? payload.id : `${callId}-output`,
      callId,
      text: callId,
      aggregatedOutput: output
    });
    return;
  }

  if (itemType === "reasoning" && Array.isArray(payload.summary) && payload.summary.length > 0) {
    const id = typeof payload.id === "string" ? payload.id : nextId();
    turn.items.push({
      type: "reasoning",
      id,
      summary: payload.summary
    });
  }
}

function sessionRoots(sessionsRoot?: string): string[] {
  return sessionsRoot ? [path.resolve(sessionsRoot)] : configuredCodexSessionRoots;
}

function isSafeCodexSessionPath(filePath: string, sessionsRoot?: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.endsWith(".jsonl") && sessionRoots(sessionsRoot).some((root) => resolved.startsWith(`${root}${path.sep}`));
}

/** Return the configured sessions root which owns a persisted rollout. This
 * includes disabled execution accounts whose history remains readable. */
export function threadJsonlSessionsRoot(filePath: string, sessionsRoot?: string): string | null {
  const resolved = path.resolve(filePath);
  if (!resolved.endsWith(".jsonl")) return null;
  return sessionRoots(sessionsRoot).find((root) => resolved.startsWith(`${root}${path.sep}`)) ?? null;
}

function sessionIdFromJsonlFilename(name: string): string | null {
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] ?? null;
}

/** Rotated rollouts can carry logical_id_native_id in their filename. Only
 * session metadata may decide which logical conversation such a file belongs to.
 * Read a bounded header, never hydrate a rollout while discovering its path. */
async function logicalSessionIdFromFilename(file: string, name: string): Promise<string | null> {
  const ids: string[] = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  if (ids.length < 2) return sessionIdFromJsonlFilename(name.replace(/\.zst$/, ""));
  const input = createReadStream(file, { highWaterMark: 8192 });
  const stream = file.endsWith(".zst") ? input.pipe(createZstdDecompress()) : input;
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const newline = chunk.indexOf(10);
      const part = chunk.subarray(0, newline < 0 ? chunk.length : newline);
      bytes += part.length;
      if (bytes > 64 * 1024) return null;
      chunks.push(part);
      if (newline >= 0) {
        const row = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
        const id = row?.payload?.id ?? row?.payload?.session_id;
        return row?.type === "session_meta" && typeof id === "string" && ids.includes(id) ? id : null;
      }
    }
    return null;
  } catch { return null; }
  finally { stream.destroy(); input.destroy(); }
}

async function buildSessionPathIndex(sessionsRoot: string): Promise<Map<string, string[]>> {
  const candidates = new Map<string, Map<string, number>>();
  async function walk(directory: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { entries = await fs.readdir(directory, { withFileTypes: true }) as unknown as typeof entries; }
    catch { return; }
    // Bound file descriptors and metadata buffers when a runtime owns many files.
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name) && isSafeCodexSessionPath(target.replace(/\.zst$/, ""), sessionsRoot)) {
        const id = await logicalSessionIdFromFilename(target, entry.name);
        if (!id) continue;
        const stat = await fs.stat(target).catch(() => null);
        if (!stat) continue;
        const canonical = target.replace(/\.zst$/, "");
        const paths = candidates.get(id) ?? new Map<string, number>();
        paths.set(canonical, Math.max(paths.get(canonical) ?? 0, stat.mtimeMs));
        candidates.set(id, paths);
      }
    }
  }
  await walk(sessionsRoot);
  return new Map([...candidates].map(([id, paths]) => [id,
    [...paths].sort((a,b) => b[1]-a[1] || b[0].localeCompare(a[0])).map(([file]) => file)
  ]));
}

async function getSessionPathIndex(sessionsRoot: string): Promise<Map<string, string[]>> {
  const root = path.resolve(sessionsRoot);
  const cached = cachedSessionPathIndexes.get(root);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.paths;
  }
  let building = buildingSessionPathIndexes.get(root);
  if (!building) {
    building = buildSessionPathIndex(root).finally(() => {
      buildingSessionPathIndexes.delete(root);
    });
    buildingSessionPathIndexes.set(root, building);
  }
  const paths = await building;
  cachedSessionPathIndexes.set(root, { paths, expiresAt: Date.now() + sessionPathIndexTtlMs });
  return paths;
}

/**
 * Keep the browser payload bounded for long-running Codex sessions.  The cursor
 * counts already-loaded items from the end of the conversation: `before = 0`
 * returns the newest page, then `nextBefore` fetches the preceding page.
 */
export function paginateThreadPayload(
  value: unknown,
  before = 0,
  limit = 120
): { thread: JsonObject; history: ThreadHistoryPage } {
  const root = recordFromUnknown(value);
  const wrappedThread = recordFromUnknown(root.thread);
  const thread = Object.keys(wrappedThread).length ? wrappedThread : root;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const normalizedBefore = Math.max(0, Math.floor(before));
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const itemAddresses: Array<{ turnIndex: number; itemIndex: number }> = [];

  turns.forEach((turnValue, turnIndex) => {
    const items = Array.isArray(recordFromUnknown(turnValue).items) ? recordFromUnknown(turnValue).items as unknown[] : [];
    items.forEach((_item, itemIndex) => itemAddresses.push({ turnIndex, itemIndex }));
  });

  const totalItems = itemAddresses.length;
  const end = Math.max(0, totalItems - normalizedBefore);
  const start = Math.max(0, end - normalizedLimit);
  const selectedItemsByTurn = new Map<number, Set<number>>();
  for (const address of itemAddresses.slice(start, end)) {
    const selected = selectedItemsByTurn.get(address.turnIndex) ?? new Set<number>();
    selected.add(address.itemIndex);
    selectedItemsByTurn.set(address.turnIndex, selected);
  }

  const pageTurns: JsonObject[] = [];
  turns.forEach((turnValue, turnIndex) => {
    const selected = selectedItemsByTurn.get(turnIndex);
    if (!selected?.size) {
      return;
    }
    const turn = recordFromUnknown(turnValue);
    const items = Array.isArray(turn.items) ? turn.items : [];
    pageTurns.push({
      ...turn,
      items: items.filter((_item, itemIndex) => selected.has(itemIndex))
    });
  });

  return {
    thread: {
      ...thread,
      turns: pageTurns
    },
    history: {
      totalItems,
      returnedItems: end - start,
      before: normalizedBefore,
      nextBefore: totalItems - start,
      hasOlder: start > 0
    }
  };
}

export function threadJsonlPathFromError(error: unknown, sessionsRoot?: string): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/failed to read thread ([^:]+\.jsonl):/);
  if (!match) {
    return null;
  }
  const filePath = match[1];
  return isSafeCodexSessionPath(filePath, sessionsRoot) ? filePath : null;
}

export async function findThreadJsonlPathById(threadId: string, sessionsRoot?: string, options: { beforeFile?: string } = {}): Promise<string | null> {
  const cleanThreadId = threadId.trim();
  if (!cleanThreadId || !/^[a-zA-Z0-9_-]+$/.test(cleanThreadId)) {
    return null;
  }

  const roots = sessionRoots(sessionsRoot);
  for (const root of roots) {
    const candidates = (await getSessionPathIndex(root)).get(cleanThreadId) ?? [];
    const position = options.beforeFile ? candidates.indexOf(path.resolve(options.beforeFile)) : -1;
    if (options.beforeFile && position < 0) continue;
    const indexedPath = candidates[position + 1];
    if (indexedPath && isSafeCodexSessionPath(indexedPath, root)) return indexedPath;
  }

  // A self-referencing continuation must move strictly to an older physical
  // source; falling back to the latest file here would create a history cycle.
  if (options.beforeFile) return null;

  async function walk(directory: string): Promise<string | null> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      return null;
    }
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(target);
        if (found) {
          return found;
        }
      } else if (entry.isFile() && (entry.name.endsWith(`${cleanThreadId}.jsonl`) || entry.name.endsWith(`${cleanThreadId}.jsonl.zst`)) && isSafeCodexSessionPath(target.replace(/\.zst$/, ''), sessionsRoot)) {
        const ids = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
        if (ids.length > 1 && await logicalSessionIdFromFilename(target, entry.name) !== cleanThreadId) continue;
        return target.replace(/\.zst$/, '');
      }
    }
    return null;
  }

  for (const root of roots) {
    const found = await walk(root);
    if (found) return found;
  }
  return null;
}

/**
 * Search an owned Codex session without constructing its full browser payload.
 * This keeps large histories searchable while avoiding a full front-end render
 * or an app-server thread/read request for every keystroke.
 */
export async function threadJsonlMatchesSearch(filePath: string, query: string, sessionsRoot?: string): Promise<boolean> {
  if (!isSafeCodexSessionPath(filePath, sessionsRoot)) {
    return false;
  }
  if (!query.trim()) {
    return true;
  }

  const lines = rolloutLines(filePath);
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as JsonlRecord;
        if (textMatchesSearch(searchTextFromPayload(record), query)) {
          return true;
        }
      } catch {
        // A malformed historical line should not make the user's whole search fail.
      }
    }
  } finally {
    await lines.return(undefined);
  }
  return false;
}

/** Read just enough metadata for a search result row; do not construct a full
 * turns/items payload for a large historical conversation. */
export async function readThreadSummaryFromJsonl(
  filePath: string,
  threadId: string,
  sessionsRoot?: string
): Promise<JsonObject> {
  if (!isSafeCodexSessionPath(filePath, sessionsRoot)) {
    throw new Error("Refusing to read a thread outside the Codex sessions directory.");
  }
  const stat = await rolloutStat(filePath);
  const lines = rolloutLines(filePath);
  let metadata: JsonObject | null = null;
  let preview = "";

  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as JsonlRecord;
        const payload = record.payload ?? {};
        if (record.type === "session_meta") {
          metadata = preferredSessionMetadata(metadata, payload, threadId);
          continue;
        }
        if (!preview && record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
          const message = payload.message.trim();
          if (!isInternalUserMessageText(message)) {
            preview = message;
          }
        }
        if (!preview && record.type === "response_item" && payload.type === "message" && payload.role === "user" && !shouldSkipMessage(payload)) {
          preview = textFromContent(payload.content).trim();
        }
        if (metadata && preview) {
          break;
        }
      } catch {
        // Ignore a malformed historical record and retain a usable search row.
      }
    }
  } finally {
    await lines.return(undefined);
  }

  if (!metadata) {
    throw new Error("Codex JSONL thread is missing session metadata.");
  }
  const createdAt = secondsFromIso(metadata.timestamp) ?? Math.floor(stat.birthtimeMs / 1000) ?? Math.floor(stat.mtimeMs / 1000);
  const updatedAt = Math.floor(stat.mtimeMs / 1000);
  const name = preview ? preview.split(/\r?\n/)[0].slice(0, 80) : null;
  return {
    id: typeof metadata.id === "string" ? metadata.id : threadId,
    sessionId: typeof metadata.session_id === "string" ? metadata.session_id : typeof metadata.id === "string" ? metadata.id : threadId,
    preview,
    name,
    ephemeral: false,
    modelProvider: metadata.model_provider ?? null,
    createdAt,
    updatedAt,
    status: { type: "recoveredFromJsonl" },
    cwd: metadata.cwd,
    turns: []
  };
}

type ParsedThreadJsonl = { thread: JsonObject; truncated?: boolean };
type ThreadJsonlReadOptions = {
  tailBytes?: number;
  startOffset?: number;
  endOffset?: number;
  syntheticTurnId?: string;
};

// At most 8 * 512KiB of source may be retained (not 24 giant object graphs).
const parsedThreadCacheLimit = 8;
const parsedThreadCacheMaxSourceBytes = 512 * 1024;
let historyParseQueue: Promise<void> = Promise.resolve();
let pendingHistoryParses = 0;
async function boundedParse(filePath: string, threadId: string, sessionsRoot?: string, options: ThreadJsonlReadOptions = {}) {
  if (pendingHistoryParses >= 32) throw new HistoryMemoryLimitError('历史读取繁忙，请稍后重试；原文未修改。');
  pendingHistoryParses++;
  const previous = historyParseQueue;
  let release!: () => void;
  historyParseQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await parseThreadFromJsonl(filePath, threadId, sessionsRoot, options); }
  finally { pendingHistoryParses--; release(); }
}
const cachedParsedThreads = new Map<string, {
  filePath: string;
  signature: string;
  value: Promise<ParsedThreadJsonl>;
}>();

export async function readThreadFromJsonl(
  filePath: string,
  threadId: string,
  sessionsRoot?: string,
  options: ThreadJsonlReadOptions = {}
): Promise<ParsedThreadJsonl> {
  if (!isSafeCodexSessionPath(filePath, sessionsRoot)) {
    throw new Error("Refusing to read a thread outside the Codex sessions directory.");
  }

  if (options.tailBytes || options.startOffset !== undefined || options.endOffset !== undefined) {
    return boundedParse(filePath, threadId, sessionsRoot, options);
  }

  const stat = await rolloutStat(filePath);
  if (stat.size > MAX_FULL_HISTORY_BYTES) throw new HistoryMemoryLimitError();
  if (stat.size > parsedThreadCacheMaxSourceBytes) {
    cachedParsedThreads.delete(filePath);
    return boundedParse(filePath, threadId, sessionsRoot);
  }
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = cachedParsedThreads.get(filePath);
  if (cached?.signature === signature) {
    // Refresh recency so repeated A/B conversation switching stays hot.
    cachedParsedThreads.delete(filePath);
    cachedParsedThreads.set(filePath, cached);
    return cached.value;
  }

  const value = boundedParse(filePath, threadId, sessionsRoot);
  cachedParsedThreads.set(filePath, { filePath, signature, value });
  while (cachedParsedThreads.size > parsedThreadCacheLimit) {
    const oldestPath = cachedParsedThreads.keys().next().value;
    if (!oldestPath) {
      break;
    }
    cachedParsedThreads.delete(oldestPath);
  }
  try {
    return await value;
  } catch (error) {
    if (cachedParsedThreads.get(filePath)?.value === value) {
      cachedParsedThreads.delete(filePath);
    }
    throw error;
  }
}

async function parseThreadFromJsonl(
  filePath: string,
  threadId: string,
  sessionsRoot?: string,
  options: ThreadJsonlReadOptions = {}
): Promise<{ thread: JsonObject; truncated?: boolean }> {
  if (!isSafeCodexSessionPath(filePath, sessionsRoot)) {
    throw new Error("Refusing to read a thread outside the Codex sessions directory.");
  }

  const readablePath = await readableRolloutPath(filePath);
  const fileStat = await fs.stat(readablePath);
  const tailBytes = Math.max(0, Math.floor(options.tailBytes ?? 0));
  let raw: string;
  let truncated = false;
  if (typeof options.startOffset === "number") {
    const startOffset = Math.max(0, Math.min(fileStat.size, Math.floor(options.startOffset)));
    const endOffset = Math.max(startOffset, Math.min(fileStat.size, Math.floor(options.endOffset ?? fileStat.size)));
    if (endOffset - startOffset > 32 * 1024 * 1024) throw new HistoryMemoryLimitError();
    const handle = await openReadableRollout(filePath);
    try {
      const headBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, fileStat.size));
      const bodyBuffer = Buffer.allocUnsafe(endOffset - startOffset);
      await handle.read(headBuffer, 0, headBuffer.length, 0);
      if (bodyBuffer.length) await handle.read(bodyBuffer, 0, bodyBuffer.length, startOffset);
      const firstLineEnd = headBuffer.indexOf(10);
      const firstLine = headBuffer.subarray(0, firstLineEnd >= 0 ? firstLineEnd : headBuffer.length).toString("utf8").trimEnd();
      const syntheticTurn = options.syntheticTurnId
        ? `${JSON.stringify({ type: "turn_context", payload: { turn_id: options.syntheticTurnId } })}\n`
        : "";
      raw = `${firstLine}\n${syntheticTurn}${bodyBuffer.toString("utf8")}`;
      truncated = startOffset > 0 || endOffset < fileStat.size;
    } finally {
      await handle.close();
    }
  } else if (tailBytes > 0 && fileStat.size > tailBytes) {
    if (tailBytes > MAX_FULL_HISTORY_BYTES) throw new HistoryMemoryLimitError();
    const handle = await openReadableRollout(filePath);
    try {
      const headBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, fileStat.size));
      const tailStart = Math.max(0, fileStat.size - tailBytes);
      const tailBuffer = Buffer.allocUnsafe(fileStat.size - tailStart);
      await handle.read(headBuffer, 0, headBuffer.length, 0);
      await handle.read(tailBuffer, 0, tailBuffer.length, tailStart);
      const headText = headBuffer.toString("utf8");
      const firstLineEnd = headText.indexOf("\n");
      const firstLine = headText.slice(0, firstLineEnd >= 0 ? firstLineEnd : headText.length).trimEnd();
      const tailText = tailBuffer.toString("utf8");
      const firstCompleteLine = tailText.indexOf("\n");
      if (!firstLine || firstCompleteLine < 0) {
        throw new HistoryMemoryLimitError('所选历史片段没有完整记录，请使用分页读取；原文未修改。');
      } else {
        raw = `${firstLine}\n${tailText.slice(firstCompleteLine + 1)}`;
        truncated = true;
      }
    } finally {
      await handle.close();
    }
  } else {
    raw = await readRolloutText(filePath);
  }
  const turns = new Map<string, FallbackTurn>();
  let metadata: JsonObject | null = null;
  let currentTurnId: string | null = null;
  let collaborationMode: "plan" | "default" | undefined;
  let itemCount = 0;
  let preview = "";
  let updatedAt = 0;

  const nextId = () => `fallback-item-${++itemCount}`;
  const ensureTurn = (turnId: string): FallbackTurn => {
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        id: turnId,
        items: [],
        itemsView: "default",
        status: "running",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null
      };
      turns.set(turnId, turn);
    }
    return turn;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const record = JSON.parse(line) as JsonlRecord;
    const payload = record.payload ?? {};
    updatedAt = Math.max(updatedAt, secondsFromIso(record.timestamp) ?? 0);

    if (record.type === "session_meta") {
      metadata = preferredSessionMetadata(metadata, payload, threadId);
      updatedAt = Math.max(updatedAt, secondsFromIso(payload.timestamp) ?? 0);
      continue;
    }

    if (record.type === "turn_context" && typeof payload.turn_id === "string") {
      currentTurnId = payload.turn_id;
      const mode = recordFromUnknown(payload.collaboration_mode).mode;
      if (mode === "plan" || mode === "default") collaborationMode = mode;
      const turn = ensureTurn(currentTurnId);
      turn.startedAt ??= secondsFromIso(record.timestamp);
      continue;
    }

    if (record.type === "event_msg") {
      if (payload.type === "thread_rolled_back" && Number.isSafeInteger(payload.num_turns) && Number(payload.num_turns) > 0) {
        const ids = [...turns.keys()].slice(-Number(payload.num_turns));
        for (const id of ids) turns.delete(id);
        currentTurnId = null;
        continue;
      }
      if (payload.type === "task_started" && typeof payload.turn_id === "string") {
        currentTurnId = payload.turn_id;
        const turn = ensureTurn(currentTurnId);
        turn.startedAt = typeof payload.started_at === "number" ? payload.started_at : secondsFromIso(record.timestamp);
      }
      if (payload.type === "task_complete" && typeof payload.turn_id === "string") {
        const turn = ensureTurn(payload.turn_id);
        turn.status = payload.error ? "failed" : "completed";
        turn.error = payload.error ? { ...AppError.from(payload.error).toPublic(), at: record.timestamp } : null;
        turn.completedAt = typeof payload.completed_at === "number" ? payload.completed_at : secondsFromIso(record.timestamp);
        turn.durationMs = typeof payload.duration_ms === "number" ? payload.duration_ms : null;
        updatedAt = Math.max(updatedAt, turn.completedAt ?? 0);
      }
      if (payload.type === "user_message" && typeof payload.message === "string" && !preview) {
        const message = payload.message.trim();
        if (!isInternalUserMessageText(message)) preview = message;
      }
      if (payload.type === "image_generation_end" && currentTurnId) {
        const turn = ensureTurn(currentTurnId);
        const savedPath = typeof payload.saved_path === "string" ? payload.saved_path : "";
        const status = typeof payload.status === "string" ? payload.status : "completed";
        turn.items.push({
          type: "imageGeneration",
          id: nextId(),
          text: "已生成图片。",
          savedPath: savedPath || undefined,
          imagePath: savedPath || undefined,
          status,
          revisedPrompt: typeof payload.revised_prompt === "string" ? payload.revised_prompt : undefined
        });
      }
      continue;
    }

    if (record.type === "response_item") {
      const turnId = getTurnId(payload, currentTurnId);
      if (!turnId) {
        continue;
      }
      const turn = ensureTurn(turnId);
      const previousLength = turn.items.length;
      appendResponseItem(turn, payload, nextId);
      for (const item of turn.items.slice(previousLength)) item.timelineAt = record.timestamp;
      if (!preview && payload.type === "message" && payload.role === "user" && !shouldSkipMessage(payload)) {
        preview = textFromContent(payload.content).trim();
      }
    }
  }

  if (!metadata) {
    throw new Error("Codex JSONL thread is missing session metadata.");
  }

  const createdAt = secondsFromIso(metadata.timestamp) ?? secondsFromIso((metadata as { created_at?: unknown }).created_at) ?? updatedAt;
  const orderedTurns = Array.from(turns.values()).map((turn) => ({
    ...turn,
    status: turn.status === "running" && turn.completedAt ? "completed" : turn.status
  }));
  const name = preview ? preview.split(/\r?\n/)[0].slice(0, 80) : null;

  return {
    thread: {
      id: typeof metadata.id === "string" ? metadata.id : threadId,
      sessionId: typeof metadata.session_id === "string" ? metadata.session_id : typeof metadata.id === "string" ? metadata.id : threadId,
      forkedFromId: null,
      parentThreadId: null,
      preview,
      ephemeral: false,
      modelProvider: metadata.model_provider ?? null,
      createdAt,
      updatedAt: updatedAt || createdAt,
      status: { type: "recoveredFromJsonl" },
      path: filePath,
      cwd: metadata.cwd,
      cliVersion: metadata.cli_version,
      ...(collaborationMode ? { collaborationMode } : {}),
      source: metadata.source,
      threadSource: metadata.thread_source ?? null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name,
      turns: orderedTurns
    }
  };
}
