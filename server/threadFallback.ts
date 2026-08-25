import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

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
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

function recordFromUnknown(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

const codexSessionsRoot = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
const configuredCodexSessionRoots = [...new Set([
  codexSessionsRoot,
  ...(process.env.CODEX_WEB_CODEX_SESSION_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
].map((entry) => path.resolve(entry)))];
const sessionPathIndexTtlMs = 60_000;
const cachedSessionPathIndexes = new Map<string, { expiresAt: number; paths: Map<string, string> }>();
const buildingSessionPathIndexes = new Map<string, Promise<Map<string, string>>>();

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
      return message.startsWith("<environment_context>") || message.startsWith("<app-context>") ? "" : message;
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
  return (
    text.startsWith("<environment_context>") ||
    text.startsWith("<recommended_plugins>") ||
    text.startsWith("<permissions instructions>") ||
    text.startsWith("<app-context>")
  );
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
      id: `${callId}-output-${turn.items.length + 1}`,
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

function sessionIdFromJsonlFilename(name: string): string | null {
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] ?? null;
}

async function buildSessionPathIndex(sessionsRoot: string): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && isSafeCodexSessionPath(target, sessionsRoot)) {
        const sessionId = sessionIdFromJsonlFilename(entry.name);
        if (sessionId) {
          paths.set(sessionId, target);
        }
      }
    }));
  }
  await walk(sessionsRoot);
  return paths;
}

async function getSessionPathIndex(sessionsRoot: string): Promise<Map<string, string>> {
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

export async function findThreadJsonlPathById(threadId: string, sessionsRoot?: string): Promise<string | null> {
  const cleanThreadId = threadId.trim();
  if (!cleanThreadId || !/^[a-zA-Z0-9_-]+$/.test(cleanThreadId)) {
    return null;
  }

  const roots = sessionRoots(sessionsRoot);
  for (const root of roots) {
    const indexedPath = (await getSessionPathIndex(root)).get(cleanThreadId);
    if (indexedPath && isSafeCodexSessionPath(indexedPath, root)) {
      return indexedPath;
    }
  }

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
      } else if (entry.isFile() && entry.name.endsWith(`${cleanThreadId}.jsonl`) && isSafeCodexSessionPath(target, sessionsRoot)) {
        return target;
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

  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as JsonlRecord;
        if (textMatchesSearch(searchTextFromPayload(record), query)) {
          lines.close();
          input.destroy();
          return true;
        }
      } catch {
        // A malformed historical line should not make the user's whole search fail.
      }
    }
  } finally {
    lines.close();
    input.destroy();
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
  const stat = await fs.stat(filePath);
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
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
          metadata = payload;
          continue;
        }
        if (!preview && record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
          const message = payload.message.trim();
          if (!message.startsWith("<environment_context>") && !message.startsWith("<app-context>")) {
            preview = message;
          }
        }
        if (!preview && record.type === "response_item" && payload.type === "message" && payload.role === "user" && !shouldSkipMessage(payload)) {
          preview = textFromContent(payload.content).trim();
        }
        if (metadata && preview) {
          lines.close();
          input.destroy();
          break;
        }
      } catch {
        // Ignore a malformed historical record and retain a usable search row.
      }
    }
  } finally {
    lines.close();
    input.destroy();
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

const parsedThreadCacheLimit = 24;
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
    return parseThreadFromJsonl(filePath, threadId, sessionsRoot, options);
  }

  const stat = await fs.stat(filePath);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = cachedParsedThreads.get(filePath);
  if (cached?.signature === signature) {
    // Refresh recency so repeated A/B conversation switching stays hot.
    cachedParsedThreads.delete(filePath);
    cachedParsedThreads.set(filePath, cached);
    return cached.value;
  }

  const value = parseThreadFromJsonl(filePath, threadId, sessionsRoot);
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

  const fileStat = await fs.stat(filePath);
  const tailBytes = Math.max(0, Math.floor(options.tailBytes ?? 0));
  let raw: string;
  let truncated = false;
  if (typeof options.startOffset === "number") {
    const startOffset = Math.max(0, Math.min(fileStat.size, Math.floor(options.startOffset)));
    const endOffset = Math.max(startOffset, Math.min(fileStat.size, Math.floor(options.endOffset ?? fileStat.size)));
    const handle = await fs.open(filePath, "r");
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
    const handle = await fs.open(filePath, "r");
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
        raw = await fs.readFile(filePath, "utf8");
      } else {
        raw = `${firstLine}\n${tailText.slice(firstCompleteLine + 1)}`;
        truncated = true;
      }
    } finally {
      await handle.close();
    }
  } else {
    raw = await fs.readFile(filePath, "utf8");
  }
  const turns = new Map<string, FallbackTurn>();
  let metadata: JsonObject | null = null;
  let currentTurnId: string | null = null;
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
      metadata = payload;
      updatedAt = Math.max(updatedAt, secondsFromIso(payload.timestamp) ?? 0);
      continue;
    }

    if (record.type === "turn_context" && typeof payload.turn_id === "string") {
      currentTurnId = payload.turn_id;
      const turn = ensureTurn(currentTurnId);
      turn.startedAt ??= secondsFromIso(record.timestamp);
      continue;
    }

    if (record.type === "event_msg") {
      if (payload.type === "task_started" && typeof payload.turn_id === "string") {
        currentTurnId = payload.turn_id;
        const turn = ensureTurn(currentTurnId);
        turn.startedAt = typeof payload.started_at === "number" ? payload.started_at : secondsFromIso(record.timestamp);
      }
      if (payload.type === "task_complete" && typeof payload.turn_id === "string") {
        const turn = ensureTurn(payload.turn_id);
        turn.status = "completed";
        turn.completedAt = typeof payload.completed_at === "number" ? payload.completed_at : secondsFromIso(record.timestamp);
        turn.durationMs = typeof payload.duration_ms === "number" ? payload.duration_ms : null;
        updatedAt = Math.max(updatedAt, turn.completedAt ?? 0);
      }
      if (payload.type === "user_message" && typeof payload.message === "string" && !preview) {
        preview = payload.message.trim();
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
      appendResponseItem(turn, payload, nextId);
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
