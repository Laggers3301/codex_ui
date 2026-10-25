import type { RpcEnvelope } from "./types.js";
import { isQuestionToolName, readLiveQuestionNotification } from "../src/questionTool.js";

type LiveTurnStatus = "running" | "completed";

// Live state is only a reconnect aid while a turn is running. The complete
// transcript is persisted by Codex and loaded through the thread history API,
// so replaying an unbounded number of tool calls here only makes every browser
// reconnect progressively more expensive.
const MAX_LIVE_AGENT_MESSAGES = 32;
const MAX_LIVE_TOOL_ITEMS = 48;
const MAX_LIVE_TOOL_TEXT_CHARS = 6_000;

export interface LiveAgentMessage {
  itemId: string;
  sourceItemId: string;
  threadId: string | null;
  turnId: string | null;
  text: string;
  completed: boolean;
  streamState?: "streaming" | "completed" | "interrupted" | "superseded";
  sequence: number;
  startedAt: string;
  updatedAt: string;
}

export interface LiveReasoningMessage {
  itemId: string;
  threadId: string | null;
  turnId: string | null;
  text: string;
  completed: boolean;
  sequence: number;
  startedAt: string;
  updatedAt: string;
}

export interface LiveToolItem {
  collaboration?: Record<string, unknown>;
  internal?: boolean;
  itemId: string;
  sourceItemId?: string;
  threadId: string | null;
  turnId: string | null;
  tool: string;
  input: string;
  output: string;
  completed: boolean;
  sequence: number;
  startedAt: string;
  updatedAt: string;
}

export interface LiveTurnState {
  threadId: string | null;
  turnId: string | null;
  status: LiveTurnStatus;
  startedAt: string;
  updatedAt: string;
}

export interface LiveStateSnapshot {
  reasoningMessages?: LiveReasoningMessage[];
  agentMessages: LiveAgentMessage[];
  toolItems: LiveToolItem[];
  activeTurns: LiveTurnState[];
  updatedAt: string | null;
}

export type LiveStateUpdate =
  | { kind: "reasoning"; item: LiveReasoningMessage }
  | { kind: "agent"; item: LiveAgentMessage }
  | { kind: "tool"; item: LiveToolItem; historyItem?: LiveToolItem };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function livePreview(text: string, maxChars = MAX_LIVE_TOOL_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  const notice = "\n…[实时预览已截断，完整内容保留在会话历史中]…\n";
  const available = Math.max(0, maxChars - notice.length);
  const headLength = Math.ceil(available * 0.65);
  return `${text.slice(0, headLength)}${notice}${text.slice(text.length - (available - headLength))}`;
}

function normalizedToken(value: unknown): string {
  return textFromValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isContextCompactionItem(item: Record<string, unknown>): boolean {
  const token = normalizedToken(item.type ?? item.kind ?? item.tool ?? item.name);
  return token.includes("contextcompaction");
}

function isToolItem(item: Record<string, unknown>): boolean {
  const token = normalizedToken(item.type ?? item.kind ?? item.tool ?? item.name);
  const knownType = [
    "commandexecution",
    "filechange",
    "mcptoolcall",
    "dynamictoolcall",
    "collabagenttoolcall",
    "websearch",
    "imageview",
    "imagegeneration",
    "contextcompaction",
    "sleep"
  ].some((kind) => token.includes(kind));
  const functionLike = token.includes("functioncall") || token.includes("toolcall") || token.includes("customtool") || token.includes("localcommand");
  const hasToolPayload = [item.command, item.input, item.arguments, item.action, item.changes, item.query, item.queries].some((value) => value !== undefined && value !== null);
  return knownType || functionLike || hasToolPayload;
}

function toolLabel(item: Record<string, unknown>): string {
  const explicit = stringOrNull(item.tool) ?? stringOrNull(item.toolName) ?? stringOrNull(item.tool_name) ?? stringOrNull(item.name);
  if (explicit) return explicit;
  const token = normalizedToken(item.type ?? item.kind);
  if (token.includes("commandexecution")) return "exec";
  if (token.includes("filechange")) return "apply_patch";
  if (token.includes("websearch")) return "web_search";
  if (token.includes("mcptoolcall")) return "mcp";
  if (token.includes("dynamictoolcall")) return "tool";
  if (token.includes("imageview")) return "view_image";
  if (token.includes("imagegeneration")) return "image_gen";
  return stringOrNull(item.type) ?? "tool";
}

function toolInput(item: Record<string, unknown>): string {
  for (const value of [item.command, item.input, item.arguments, item.action, item.changes, item.query, item.queries, item.path, item.imagePath, item.image_path]) {
    const text = textFromValue(value);
    if (text.trim()) return text;
  }
  return "";
}

function toolOutput(item: Record<string, unknown>): string {
  const aggregated = textFromValue(item.aggregatedOutput ?? item.aggregated_output);
  if (aggregated.trim()) return aggregated;
  const stdout = textFromValue(item.stdout);
  const stderr = textFromValue(item.stderr);
  if (stdout || stderr) return `${stdout}${stderr}`;
  for (const value of [item.output, item.result, item.summary]) {
    const text = textFromValue(value);
    if (text.trim()) return text;
  }
  return "";
}

function turnFields(params: Record<string, unknown>): { threadId: string | null; turnId: string | null } {
  const turn = asRecord(params.turn);
  const thread = asRecord(params.thread);
  return {
    threadId: stringOrNull(params.threadId) ?? stringOrNull(thread.id),
    turnId: stringOrNull(params.turnId) ?? stringOrNull(turn.id)
  };
}

function matchesTurn(message: { threadId: string | null; turnId: string | null }, threadId: string | null, turnId: string | null): boolean {
  if (turnId && message.turnId === turnId) {
    return true;
  }
  if (threadId && message.threadId === threadId) {
    return true;
  }
  return false;
}

export class LiveStateStore {
  private readonly reasoningMessages = new Map<string, LiveReasoningMessage>();
  private readonly reasoningParts = new Map<string, Map<number, string>>();
  private readonly agentMessages = new Map<string, LiveAgentMessage>();
  private readonly activeAgentSegments = new Map<string, string>();
  private readonly toolItems = new Map<string, LiveToolItem>();
  private readonly activeTurns = new Map<string, LiveTurnState>();
  private nextSequence = 0;
  private updatedAt: string | null = null;

  private hasActiveTurn(params: Record<string, unknown>): boolean {
    const { threadId, turnId } = turnFields(params);
    if (threadId && this.activeTurns.has(threadId)) return true;
    if (turnId && Array.from(this.activeTurns.values()).some((turn) => turn.turnId === turnId)) return true;
    return !threadId && !turnId && this.activeTurns.size === 1;
  }

  private pruneAgentMessages(): void {
    while (this.agentMessages.size > MAX_LIVE_AGENT_MESSAGES) {
      const oldest = this.agentMessages.keys().next().value as string | undefined;
      if (!oldest) break;
      this.agentMessages.delete(oldest);
    }
    for (const [sourceItemId, segmentId] of this.activeAgentSegments.entries()) {
      if (!this.agentMessages.has(segmentId)) {
        this.activeAgentSegments.delete(sourceItemId);
      }
    }
  }

  private pruneToolItems(): void {
    while (this.toolItems.size > MAX_LIVE_TOOL_ITEMS) {
      const completed = Array.from(this.toolItems.entries()).find(([, item]) => item.completed)?.[0];
      const oldest = completed ?? (this.toolItems.keys().next().value as string | undefined);
      if (!oldest) break;
      this.toolItems.delete(oldest);
    }
  }

  recordNotification(envelope: RpcEnvelope): LiveStateUpdate | null {
    const params = asRecord(envelope.params);
    const method = envelope.method ?? "";
    const reasoning = this.recordReasoning(method, params);
    if (reasoning) return { kind: "reasoning", item: reasoning };
    if (method === "item/agentMessage/delta") {
      if (!this.hasActiveTurn(params)) return null;
      const agent = this.recordAgentMessageDelta(params);
      return agent ? { kind: "agent", item: agent } : null;
    }
    const typedItemEvent = method.match(/^item\/(.+)\/(started|completed|outputDelta)$/);
    const genericItemEvent = method.match(/^item\/(started|completed|outputDelta)$/);
    if (typedItemEvent || genericItemEvent) {
      if (!this.hasActiveTurn(params)) return null;
      const item = asRecord(params.item);
      const eventType = typedItemEvent?.[1] ?? item.type;
      const eventPhase = typedItemEvent?.[2] ?? genericItemEvent?.[1];
      const question = readLiveQuestionNotification(envelope);
      if (question) {
        const tool = this.recordToolItem({ ...params, item: {
          ...item, type: "toolCall", tool: question.tool, input: question.input
        } }, question.completed);
        return tool ? { kind: "tool", item: { ...tool, input: livePreview(tool.input), output: livePreview(tool.output) }, historyItem: tool } : null;
      }
      if (eventType === "agentMessage" || item.type === "agentMessage") {
        const id = stringOrNull(item.id) ?? stringOrNull(params.itemId);
        const content = Array.isArray(item.content) ? item.content.map(value => {
          const part = asRecord(value);
          return ["text", "output_text"].includes(String(part.type)) && typeof part.text === "string" ? part.text : "";
        }).join("") : undefined;
        const fullText = typeof item.text === "string" ? item.text : content;
        if (!id || fullText === undefined) return null;
        const existing = this.agentMessages.get(id);
        if (existing?.completed && eventPhase !== "completed") return null;
        // Item completion is an authoritative snapshot, not another delta.
        // Preserve the existing identity/order and do not append it twice.
        let agent = existing;
        if (!agent && fullText) agent = this.recordAgentMessageDelta({ ...params, itemId: id, delta: fullText }) ?? undefined;
        if (!agent) return null;
        const next: LiveAgentMessage = { ...agent, text: fullText || agent.text, completed: eventPhase === "completed", streamState: eventPhase === "completed" ? "completed" : "streaming", updatedAt: new Date().toISOString() };
        this.agentMessages.set(id, next);
        return { kind: "agent", item: next };
      }
      const eventItem = {
        ...item,
        type: item.type ?? eventType,
        output: item.output ?? params.delta ?? params.output
      };
      const tool = this.recordToolItem(
        { ...params, item: eventItem },
        eventPhase === "completed"
      );
      return tool ? { kind: "tool", item: { ...tool, input: livePreview(tool.input), output: livePreview(tool.output) }, historyItem: tool } : null;
    }
    if (envelope.method === "turn/started") {
      this.recordTurnStarted(params);
      return null;
    }
    if (envelope.method === "turn/completed") {
      this.recordTurnCompleted(params);
    }
    return null;
  }

  /** Only retire an interrupted sampling attempt after a native message completes. */
  recordAgentRecovery(envelope: RpcEnvelope): LiveAgentMessage[] {
    const params = asRecord(envelope.params);
    const { threadId, turnId } = turnFields(params);
    if (!threadId || !turnId || !this.hasActiveTurn(params)) return [];
    const error = envelope.method === "error";
    const item = asRecord(params.item);
    const finished = /^(?:item\/completed|item\/agentMessage\/completed)$/.test(envelope.method ?? "")
      && (item.type === "agentMessage" || envelope.method === "item/agentMessage/completed")
      && item.delivery !== "async"
      && typeof item.id === "string" && this.agentMessages.get(item.id)?.completed;
    if (!error && !finished) return [];
    const changed: LiveAgentMessage[] = [];
    for (const [id, message] of this.agentMessages) {
      if (message.threadId !== threadId || message.turnId !== turnId || message.completed || message.streamState === "superseded") continue;
      const state = error ? "interrupted" : message.streamState === "interrupted" && id !== item.id ? "superseded" : null;
      if (!state || state === message.streamState) continue;
      const next: LiveAgentMessage = { ...message, streamState: state, updatedAt: new Date().toISOString() };
      this.agentMessages.set(id, next); changed.push(next);
    }
    return changed;
  }

  snapshot(): LiveStateSnapshot {
    return {
      reasoningMessages: Array.from(this.reasoningMessages.values()).map(item => ({ ...item })),
      agentMessages: Array.from(this.agentMessages.values()).map((message) => ({ ...message })),
      toolItems: Array.from(this.toolItems.values()).map((item) => ({ ...item })),
      activeTurns: Array.from(this.activeTurns.values()).map((turn) => ({ ...turn })),
      updatedAt: this.updatedAt
    };
  }

  clear(): void {
    this.reasoningMessages.clear();
    this.reasoningParts.clear();
    this.agentMessages.clear();
    this.activeAgentSegments.clear();
    this.toolItems.clear();
    this.activeTurns.clear();
    this.nextSequence = 0;
    this.updatedAt = null;
  }

  /** Public summaries only. Never inspect encrypted reasoning or raw content. */
  private recordReasoning(method: string, params: Record<string, unknown>): LiveReasoningMessage | null {
    const item = asRecord(params.item);
    const summaryDelta = method === "item/reasoning/summaryTextDelta";
    const summaryPart = method === "item/reasoning/summaryPartAdded";
    const lifecycle = /^(?:item\/(?:reasoning\/)?)(?:started|completed)$/.test(method)
      && (normalizedToken(item.type) === "reasoning" || method.startsWith("item/reasoning/"));
    if ((!summaryDelta && !summaryPart && !lifecycle) || !this.hasActiveTurn(params)) return null;
    const { threadId, turnId } = turnFields(params);
    const active = threadId ? this.activeTurns.get(threadId) : turnId ? Array.from(this.activeTurns.values()).find(t => t.turnId === turnId) : this.activeTurns.size === 1 ? this.activeTurns.values().next().value : undefined;
    if (turnId && active?.turnId !== turnId) return null;
    const id = stringOrNull(params.itemId) ?? stringOrNull(item.id);
    if (!id) return null;
    const previous = this.reasoningMessages.get(id);
    if (previous?.completed) return null;
    const parts = this.reasoningParts.get(id) ?? new Map<number, string>();
    const index = typeof params.summaryIndex === "number" && Number.isInteger(params.summaryIndex) ? params.summaryIndex : 0;
    if (index < 0 || index >= 128) return null;
    if (summaryDelta && typeof params.delta === "string") {
      const remaining = Math.max(0, 64_000 - Array.from(parts.values()).reduce((n, text) => n + text.length, 0));
      parts.set(index, (parts.get(index) ?? "") + params.delta.slice(0, remaining));
    }
    const complete = lifecycle && method.endsWith("completed");
    // A completed native item is a snapshot, not another delta to append.
    if (lifecycle && Array.isArray(item.summary)) {
      const texts = item.summary.slice(0, 128).map(p => typeof p === "string" ? p : typeof asRecord(p).text === "string" ? asRecord(p).text as string : "");
      if (texts.some(Boolean) && (complete || !previous?.text || texts.join("\n\n").length >= previous.text.length)) {
        parts.clear();
        let budget = 64_000;
        texts.forEach((text, i) => { parts.set(i, text.slice(0, budget)); budget = Math.max(0, budget - text.length); });
      }
    }
    const now = new Date().toISOString();
    const next: LiveReasoningMessage = { itemId: id, threadId: previous?.threadId ?? threadId ?? active?.threadId ?? null,
      turnId: previous?.turnId ?? turnId ?? active?.turnId ?? null,
      text: Array.from(parts).sort(([a], [b]) => a - b).map(([, text]) => text).join("\n\n").slice(0, 64_000),
      completed: complete, sequence: previous?.sequence ?? ++this.nextSequence, startedAt: previous?.startedAt ?? now, updatedAt: now };
    this.reasoningParts.set(id, parts);
    this.reasoningMessages.set(id, next);
    while (this.reasoningMessages.size > 32) {
      const oldest = this.reasoningMessages.keys().next().value!;
      this.reasoningMessages.delete(oldest); this.reasoningParts.delete(oldest);
    }
    this.updatedAt = now;
    return next;
  }

  private recordAgentMessageDelta(params: Record<string, unknown>): LiveAgentMessage | null {
    const item = asRecord(params.item);
    const sourceItemId = stringOrNull(params.itemId) ?? stringOrNull(item.id) ?? stringOrNull(item.itemId);
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!sourceItemId || !delta) {
      return null;
    }
    if (isQuestionToolName(this.toolItems.get(sourceItemId)?.tool)) return null;

    const now = new Date().toISOString();
    const { threadId, turnId } = turnFields(params);
    const inferredTurn = threadId
      ? this.activeTurns.get(threadId)
      : turnId
        ? Array.from(this.activeTurns.values()).find((turn) => turn.turnId === turnId)
        : this.activeTurns.size === 1
          ? this.activeTurns.values().next().value
          : undefined;
    const resolvedThreadId = threadId ?? inferredTurn?.threadId ?? null;
    const resolvedTurnId = turnId ?? inferredTurn?.turnId ?? null;
    const activeSegmentId = this.activeAgentSegments.get(sourceItemId);
    const activeSegment = activeSegmentId ? this.agentMessages.get(activeSegmentId) : undefined;
    if (activeSegment?.completed || activeSegment?.streamState === "superseded") return null;
    // A streamed message keeps its identity and first-seen position even when
    // an asynchronous tool completion arrives between two text deltas.
    const sequence = activeSegment?.sequence ?? ++this.nextSequence;
    const itemId = sourceItemId;
    const existing = activeSegment;
    const next: LiveAgentMessage = {
      itemId,
      sourceItemId,
      threadId: resolvedThreadId ?? existing?.threadId ?? null,
      turnId: resolvedTurnId ?? existing?.turnId ?? null,
      text: `${existing?.text ?? ""}${delta}`,
      completed: existing?.completed ?? false,
      streamState: existing?.streamState ?? "streaming",
      sequence,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now
    };
    this.agentMessages.set(itemId, next);
    this.activeAgentSegments.set(sourceItemId, itemId);
    this.pruneAgentMessages();
    this.updatedAt = now;
    return next;
  }

  private recordToolItem(params: Record<string, unknown>, completed: boolean): LiveToolItem | null {
    const item = asRecord(params.item);
    if (!isToolItem(item)) {
      return null;
    }
    const rawItemId = stringOrNull(params.itemId) ?? stringOrNull(item.id);
    const call = asRecord(item.call);
    const callId =
      stringOrNull(params.callId)
      ?? stringOrNull(params.call_id)
      ?? stringOrNull(params.toolCallId)
      ?? stringOrNull(params.tool_call_id)
      ?? stringOrNull(item.callId)
      ?? stringOrNull(item.call_id)
      ?? stringOrNull(item.toolCallId)
      ?? stringOrNull(item.tool_call_id)
      ?? stringOrNull(call.id);
    const itemId = callId ?? rawItemId;
    if (!itemId) return null;
    const now = new Date().toISOString();
    const { threadId, turnId } = turnFields(params);
    const existing = this.toolItems.get(itemId);
    const activeTurn = threadId ? this.activeTurns.get(threadId) : undefined;
    const next: LiveToolItem = {
      itemId,
      sourceItemId: rawItemId ?? existing?.sourceItemId,
      threadId: existing?.threadId ?? threadId,
      turnId: existing?.turnId ?? turnId ?? activeTurn?.turnId ?? null,
      tool: toolLabel(item) || existing?.tool || "tool",
      internal: isContextCompactionItem(item) || existing?.internal,
      ...(normalizedToken(item.type) === "collabagenttoolcall" ? { collaboration: {
        type: "collabAgentToolCall", tool: item.tool, status: item.status, senderThreadId: item.senderThreadId,
        receiverThreadIds: item.receiverThreadIds, agentsStates: item.agentsStates, model: item.model
      } } : existing?.collaboration ? { collaboration: existing.collaboration } : {}),
      input: toolInput(item) || existing?.input || "",
      output: toolOutput(item) || existing?.output || "",
      completed: completed || existing?.completed || false,
      sequence: existing?.sequence ?? ++this.nextSequence,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now
    };
    this.toolItems.set(itemId, { ...next, input: livePreview(next.input), output: livePreview(next.output) });
    this.pruneToolItems();
    this.updatedAt = now;
    return next;
  }

  private recordTurnStarted(params: Record<string, unknown>): void {
    const { threadId, turnId } = turnFields(params);
    if (!threadId && !turnId) {
      return;
    }
    const now = new Date().toISOString();
    this.activeTurns.set(threadId ?? turnId ?? "unknown", {
      threadId,
      turnId,
      status: "running",
      startedAt: now,
      updatedAt: now
    });
    this.updatedAt = now;
  }

  private recordTurnCompleted(params: Record<string, unknown>): void {
    const { threadId, turnId } = turnFields(params);
    if (!threadId && !turnId) {
      return;
    }
    const now = new Date().toISOString();

    for (const [id, message] of this.reasoningMessages) {
      if (turnId ? message.turnId === turnId : message.threadId === threadId) {
        this.reasoningMessages.delete(id); this.reasoningParts.delete(id);
      }
    }

    for (const [key, turn] of this.activeTurns.entries()) {
      if ((turnId && turn.turnId === turnId) || (threadId && turn.threadId === threadId)) {
        this.activeTurns.set(key, { ...turn, status: "completed", updatedAt: now });
        this.activeTurns.delete(key);
      }
    }

    for (const [itemId, message] of this.agentMessages.entries()) {
      if (matchesTurn(message, threadId, turnId)) {
        this.agentMessages.delete(itemId);
      }
    }
    for (const [sourceItemId, segmentId] of this.activeAgentSegments.entries()) {
      if (!this.agentMessages.has(segmentId)) {
        this.activeAgentSegments.delete(sourceItemId);
      }
    }
    for (const [itemId, item] of this.toolItems.entries()) {
      if (matchesTurn(item, threadId, turnId)) {
        this.toolItems.delete(itemId);
      }
    }
    this.updatedAt = now;
  }
}
