import type { RpcEnvelope } from "./types.js";

type Phase = "requested" | "candidate" | "summarizing" | "finishing";

interface CandidateUsage {
  signature: string;
  total: number;
  window: number;
  firstObservedAt: number;
  latestObservedAt: number;
  repeated: boolean;
}

interface CompactState {
  phase: Phase;
  compactItemId?: string;
  candidate?: CandidateUsage;
  threadCompacted?: boolean;
  compactItemCompleted?: boolean;
}

export interface RawCompactFilterOptions {
  candidateDelayMs?: number;
  candidateTtlMs?: number;
  highWaterRatio?: number;
  now?: () => number;
}

const DEFAULT_CANDIDATE_DELAY_MS = 20_000;
const DEFAULT_CANDIDATE_TTL_MS = 600_000;
const DEFAULT_HIGH_WATER_RATIO = 0.9;
const REPEAT_GAP_MS = 5_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedToken(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function envelopeThreadId(envelope: RpcEnvelope): string | null {
  const params = asRecord(envelope.params);
  const turn = asRecord(params.turn);
  const thread = asRecord(params.thread);
  return stringOrNull(params.threadId) ?? stringOrNull(turn.threadId) ?? stringOrNull(thread.id);
}

function envelopeItem(envelope: RpcEnvelope): Record<string, unknown> {
  const params = asRecord(envelope.params);
  return asRecord(params.item);
}

function itemId(item: Record<string, unknown>): string | null {
  return stringOrNull(item.id) ?? stringOrNull(item.itemId);
}

function itemTypeToken(item: Record<string, unknown>, method: string): string {
  const typed = method.match(/^item\/([^/]+)\/(?:started|completed|.*delta)$/)?.[1] ?? "";
  return normalizedToken(item.type ?? item.kind ?? item.tool ?? item.name ?? typed);
}

function isContextCompactionItem(item: Record<string, unknown>, method: string): boolean {
  return itemTypeToken(item, method).includes("contextcompaction");
}

function isReasoningItem(item: Record<string, unknown>, method: string): boolean {
  return itemTypeToken(item, method).includes("reasoning");
}

function isAgentMessageItem(item: Record<string,unknown>, method: string): boolean {
  const token = itemTypeToken(item, method);
  return token.includes("agentmessage") || token === "message";
}

function isCompactSummaryPayload(item: Record<string, unknown>): boolean {
  const token = normalizedToken(item.type ?? item.role ?? item.kind);
  return token.includes("reasoning") || token === "message";
}

function isUnambiguousToolItem(item: Record<string, unknown>, method: string): boolean {
  if (method === "turn/diff/updated" || method.includes("/approval")) {
    return true;
  }
  if (!method.startsWith("item/")) {
    return false;
  }

  const token = itemTypeToken(item, method);
  if (!token || token.includes("reasoning") || token.includes("agentmessage") || token === "message") {
    return false;
  }

  const knownTool = [
    "commandexecution",
    "filechange",
    "mcptoolcall",
    "dynamictoolcall",
    "collabagenttoolcall",
    "websearch",
    "imageview",
    "imagegeneration",
    "functioncall",
    "toolcall",
    "requestpermissions",
    "localcommand",
    "customtool"
  ].some((kind) => token.includes(kind));
  const toolPayload = [item.command, item.input, item.arguments, item.action, item.changes, item.query, item.queries]
    .some((value) => value !== undefined && value !== null);

  return knownTool || toolPayload;
}

function isSummaryNotification(method: string, item: Record<string, unknown>): boolean {
  if (method === "item/agentMessage/delta" || method.startsWith("item/reasoning/")) {
    return true;
  }

  if (method === "item/started" || method === "item/completed") {
    return isReasoningItem(item, method) || isAgentMessageItem(item, method);
  }

  return method === "rawResponseItem/completed" && isCompactSummaryPayload(item);
}

export function notificationIsContextCompaction(envelope: RpcEnvelope): boolean {
  return isContextCompactionItem(envelopeItem(envelope), envelope.method ?? "");
}

export class RawCompactFilter {
  private readonly states = new Map<string, CompactState>();
  private readonly candidateDelayMs: number;
  private readonly candidateTtlMs: number;
  private readonly highWaterRatio: number;
  private readonly now: () => number;

  constructor(options: RawCompactFilterOptions = {}) {
    this.candidateDelayMs = options.candidateDelayMs ?? DEFAULT_CANDIDATE_DELAY_MS;
    this.candidateTtlMs = options.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS;
    this.highWaterRatio = options.highWaterRatio ?? DEFAULT_HIGH_WATER_RATIO;
    this.now = options.now ?? (() => Date.now());
  }

  markRequested(threadId: string): void {
    if (!this.states.has(threadId)) {
      this.states.set(threadId, { phase: "requested" });
    }
  }

  clear(threadId: string): void {
    this.states.delete(threadId);
  }

  observe(envelope: RpcEnvelope): boolean {
    const threadId = envelopeThreadId(envelope);
    if (!threadId) {
      return false;
    }

    const method = envelope.method ?? "";
    if (method === "turn/completed" || method === "turn/failed" || method.endsWith("/error")) {
      this.states.delete(threadId);
      return false;
    }

    const item = envelopeItem(envelope);
    if (method === "item/started" && isContextCompactionItem(item, method)) {
      this.states.set(threadId, {
        phase: "summarizing",
        compactItemId: itemId(item) ?? undefined
      });
      return true;
    }

    if (method === "thread/tokenUsage/updated") {
      this.observeTokenUsage(threadId, asRecord(envelope.params));
      return false;
    }

    if (isUnambiguousToolItem(item, method)) {
      const state = this.states.get(threadId);
      if (state && !isContextCompactionItem(item, method)) {
        this.states.delete(threadId);
      }
      return false;
    }

    if (method === "thread/compacted") {
      const state = this.states.get(threadId);
      if (state?.compactItemCompleted) {
        this.states.delete(threadId);
      } else {
        this.states.set(threadId, { ...state, phase: "finishing", threadCompacted: true });
      }
      return true;
    }

    if (method === "item/completed" && isContextCompactionItem(item, method)) {
      const state = this.states.get(threadId);
      if (state?.threadCompacted) {
        this.states.delete(threadId);
      } else {
        this.states.set(threadId, {
          ...state,
          phase: "finishing",
          compactItemId: itemId(item) ?? state?.compactItemId,
          compactItemCompleted: true
        });
      }
      return true;
    }

    const state = this.states.get(threadId);
    if (!state) {
      return false;
    }

    if (state.phase === "candidate") {
      if (!this.candidateIsReady(state)) {
        return false;
      }
      if (!isSummaryNotification(method, item)) {
        return false;
      }
      this.states.set(threadId, {
        phase: "summarizing",
        compactItemId: state.compactItemId
      });
      return true;
    }

    if (state.phase !== "summarizing") {
      return false;
    }

    return isSummaryNotification(method, item);
  }

  private observeTokenUsage(threadId: string, params: Record<string, unknown>): void {
    const usage = this.tokenUsage(params);
    if (!usage) {
      return;
    }

    const at = this.now();
    const state = this.states.get(threadId);
    const previous = state?.candidate;
    if (previous && previous.signature === usage.signature) {
      if (at - previous.latestObservedAt >= REPEAT_GAP_MS) {
        this.states.set(threadId, {
          ...state,
          phase: "candidate",
          candidate: { ...previous, latestObservedAt: at, repeated: true }
        });
      }
      return;
    }

    this.states.set(threadId, {
      ...state,
      phase: "candidate",
      candidate: {
        ...usage,
        firstObservedAt: at,
        latestObservedAt: at,
        repeated: false
      }
    });
  }

  private tokenUsage(params: Record<string, unknown>): Omit<CandidateUsage, "firstObservedAt" | "latestObservedAt" | "repeated"> | null {
    const info = asRecord(params.tokenUsage ?? params.token_usage ?? params.usage ?? params.info);
    const lastUsage = asRecord(info.last_token_usage ?? info.lastTokenUsage);
    const totalUsage = asRecord(info.total_token_usage ?? info.totalTokenUsage);
    const total = finiteNumber(lastUsage.total_tokens ?? totalUsage.total_tokens);
    const window = finiteNumber(info.model_context_window ?? info.modelContextWindow);

    if (total === null || window === null || window <= 0 || total / window < this.highWaterRatio) {
      return null;
    }

    return {
      signature: `${window}:${total}`,
      total,
      window
    };
  }

  private candidateIsReady(state: CompactState): boolean {
    const candidate = state.candidate;
    if (!candidate) {
      return false;
    }

    const at = this.now();
    if (at - candidate.latestObservedAt > this.candidateTtlMs) {
      return false;
    }

    return candidate.repeated && at - candidate.latestObservedAt >= this.candidateDelayMs;
  }
}
