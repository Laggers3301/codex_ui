import type { RpcEnvelope } from "./types.js";

type LiveTurnStatus = "running" | "completed";

export interface LiveAgentMessage {
  itemId: string;
  threadId: string | null;
  turnId: string | null;
  text: string;
  completed: boolean;
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
  agentMessages: LiveAgentMessage[];
  activeTurns: LiveTurnState[];
  updatedAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function turnFields(params: Record<string, unknown>): { threadId: string | null; turnId: string | null } {
  const turn = asRecord(params.turn);
  const thread = asRecord(params.thread);
  return {
    threadId: stringOrNull(params.threadId) ?? stringOrNull(thread.id),
    turnId: stringOrNull(params.turnId) ?? stringOrNull(turn.id)
  };
}

function matchesTurn(message: LiveAgentMessage, threadId: string | null, turnId: string | null): boolean {
  if (turnId && message.turnId === turnId) {
    return true;
  }
  if (threadId && message.threadId === threadId) {
    return true;
  }
  return false;
}

export class LiveStateStore {
  private readonly agentMessages = new Map<string, LiveAgentMessage>();
  private readonly activeTurns = new Map<string, LiveTurnState>();
  private updatedAt: string | null = null;

  recordNotification(envelope: RpcEnvelope): void {
    const params = asRecord(envelope.params);
    if (envelope.method === "item/agentMessage/delta") {
      this.recordAgentMessageDelta(params);
      return;
    }
    if (envelope.method === "turn/started") {
      this.recordTurnStarted(params);
      return;
    }
    if (envelope.method === "turn/completed") {
      this.recordTurnCompleted(params);
    }
  }

  snapshot(threadId?: string | null): LiveStateSnapshot {
    const matchesRequestedThread = <T extends { threadId: string | null }>(entry: T): boolean =>
      threadId === undefined || entry.threadId === threadId;
    return {
      agentMessages: Array.from(this.agentMessages.values())
        .filter(matchesRequestedThread)
        .map((message) => ({ ...message })),
      activeTurns: Array.from(this.activeTurns.values())
        .filter(matchesRequestedThread)
        .map((turn) => ({ ...turn })),
      updatedAt: this.updatedAt
    };
  }

  clear(): void {
    this.agentMessages.clear();
    this.activeTurns.clear();
    this.updatedAt = null;
  }

  private recordAgentMessageDelta(params: Record<string, unknown>): void {
    const itemId = stringOrNull(params.itemId);
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!itemId || !delta) {
      return;
    }

    const now = new Date().toISOString();
    const { threadId, turnId } = turnFields(params);
    const existing = this.agentMessages.get(itemId);
    this.agentMessages.set(itemId, {
      itemId,
      threadId: existing?.threadId ?? threadId,
      turnId: existing?.turnId ?? turnId,
      text: `${existing?.text ?? ""}${delta}`,
      completed: existing?.completed ?? false,
      updatedAt: now
    });
    this.updatedAt = now;
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
    this.updatedAt = now;
  }
}
