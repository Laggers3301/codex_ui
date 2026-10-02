export type TurnWatchdogPhase = "running" | "tool_running" | "waiting_approval" | "waiting_subagents" | "unknown";

export interface WatchdogTurn {
  userId: string;
  accountId: string;
  threadId: string;
  turnId: string;
  startedAt: number;
  lastProgressAt: number;
  lastProgressMethod: string;
  phase: TurnWatchdogPhase;
  diagnosed: boolean;
  lastProbeAt: number | null;
  probeToken: number | null;
  lastProbeState: string | null;
  activeFlags: string[];
}

export interface WatchdogProbeClaim {
  turn: WatchdogTurn;
  token: number;
  shouldDiagnose: boolean;
}

function keyOf(userId: string, accountId: string, threadId: string): string {
  return JSON.stringify([userId, accountId, threadId]);
}

function normalizedFlag(value: unknown): string {
  if (typeof value === "string") return value.toLowerCase().replace(/[^a-z]/g, "");
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return String(item.type ?? item.name ?? item.flag ?? "").toLowerCase().replace(/[^a-z]/g, "");
  }
  return "";
}

export function phaseFromProbe(activeFlags: unknown): TurnWatchdogPhase {
  const flags = Array.isArray(activeFlags) ? activeFlags.map(normalizedFlag) : [];
  if (flags.some((flag) => flag.includes("approval"))) return "waiting_approval";
  if (flags.some((flag) => flag.includes("subagent") || flag.includes("collabagent"))) return "waiting_subagents";
  return "running";
}

/** In-memory, per-user/account/thread turn telemetry. Probes and phase updates
 * deliberately never advance lastProgressAt. This class does not recover,
 * interrupt, or replay turns. */
export class TurnWatchdog {
  private readonly turns = new Map<string, WatchdogTurn>();
  private nextProbeToken = 1;

  start(userId: string, accountId: string | null, threadId: string, turnId: string, now = Date.now()): WatchdogTurn {
    const key = keyOf(userId, accountId ?? "default", threadId);
    const existing = this.turns.get(key);
    if (existing?.turnId === turnId) return existing;
    const turn: WatchdogTurn = {
      userId,
      accountId: accountId ?? "default",
      threadId,
      turnId,
      startedAt: now,
      lastProgressAt: now,
      lastProgressMethod: "turn/started",
      phase: "running",
      diagnosed: false,
      lastProbeAt: null,
      probeToken: null,
      lastProbeState: null,
      activeFlags: []
    };
    // Replacing the map value invalidates any outstanding probe for an older turn.
    this.turns.set(key, turn);
    return turn;
  }

  get(userId: string, accountId: string | null, threadId: string): WatchdogTurn | null {
    return this.turns.get(keyOf(userId, accountId ?? "default", threadId)) ?? null;
  }

  progress(userId: string, accountId: string | null, threadId: string, turnId: string, method: string, now = Date.now()): { turn: WatchdogTurn; resumed: boolean } | null {
    const turn = this.get(userId, accountId, threadId);
    if (!turn || turn.turnId !== turnId) return null;
    const resumed = turn.diagnosed;
    // Invalidate an outstanding read snapshot even when it belongs to this
    // same turn: its older phase must not overwrite this newer progress.
    turn.probeToken = null;
    turn.lastProgressAt = now;
    turn.lastProgressMethod = method;
    turn.phase = "running";
    turn.diagnosed = false;
    return { turn, resumed };
  }

  setPhase(userId: string, accountId: string | null, threadId: string, turnId: string | null, phase: TurnWatchdogPhase, activeFlags?: string[]): WatchdogTurn | null {
    const turn = this.get(userId, accountId, threadId);
    if (!turn || (turnId && turn.turnId !== turnId)) return null;
    turn.phase = phase;
    if (activeFlags) turn.activeFlags = [...activeFlags].slice(0, 16);
    return turn;
  }

  claimDueProbes(now = Date.now(), staleAfterMs = 120_000, probeEveryMs = 60_000): WatchdogProbeClaim[] {
    const claims: WatchdogProbeClaim[] = [];
    for (const turn of this.turns.values()) {
      if (now - turn.lastProgressAt < staleAfterMs || turn.probeToken !== null) continue;
      if (turn.lastProbeAt !== null && now - turn.lastProbeAt < probeEveryMs) continue;
      const shouldDiagnose = !turn.diagnosed;
      turn.diagnosed = true;
      turn.lastProbeAt = now;
      const token = this.nextProbeToken++;
      turn.probeToken = token;
      claims.push({ turn, token, shouldDiagnose });
    }
    return claims;
  }

  resolveProbe(userId: string, accountId: string | null, threadId: string, turnId: string, token: number, status: string, activeFlags: unknown): { turn: WatchdogTurn; changed: boolean } | null {
    const turn = this.get(userId, accountId, threadId);
    if (!turn || turn.turnId !== turnId || turn.probeToken !== token) return null;
    const flags = Array.isArray(activeFlags) ? activeFlags.map((flag) => String(flag)).slice(0, 16) : [];
    const nextPhase = Array.isArray(activeFlags) && activeFlags.length === 0
      && (turn.phase === "waiting_approval" || turn.phase === "waiting_subagents")
      ? turn.phase
      : phaseFromProbe(activeFlags);
    const nextState = `${status}:${flags.join(",")}`;
    const changed = turn.phase !== nextPhase || turn.lastProbeState !== nextState;
    turn.phase = nextPhase;
    turn.activeFlags = flags;
    turn.lastProbeState = nextState;
    turn.probeToken = null;
    return { turn, changed };
  }

  failProbe(userId: string, accountId: string | null, threadId: string, turnId: string, token: number): boolean {
    const turn = this.get(userId, accountId, threadId);
    if (!turn || turn.turnId !== turnId || turn.probeToken !== token) return false;
    turn.probeToken = null;
    return true;
  }

  finish(userId: string, accountId: string | null, threadId: string, turnId: string): WatchdogTurn | null {
    const key = keyOf(userId, accountId ?? "default", threadId);
    const turn = this.turns.get(key);
    if (!turn || turn.turnId !== turnId) return null;
    this.turns.delete(key);
    return turn;
  }

  activeForAccount(accountId?: string | null): WatchdogTurn[] {
    return [...this.turns.values()].filter((turn) => accountId ? turn.accountId === accountId : turn.accountId === "default");
  }

  diagnosedForUser(userId: string): WatchdogTurn[] {
    return [...this.turns.values()].filter((turn) => turn.userId === userId && turn.diagnosed);
  }
}

export function meaningfulTurnProgressMethod(envelope: { method?: string; params?: unknown }): string | null {
  const method = envelope.method ?? "";
  if (method === "turn/diff/updated") return method;
  if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta") {
    const params = envelope.params && typeof envelope.params === "object" ? envelope.params as Record<string, unknown> : {};
    const delta = params.delta ?? params.text;
    return typeof delta === "string" && delta.length > 0 ? method : null;
  }
  if (/^item\/.+\/(started|completed)$/.test(method) || /^item\/(started|completed)$/.test(method)) return method;
  if (/^item\/.+\/outputDelta$/.test(method) || method === "item/outputDelta") {
    const params = envelope.params && typeof envelope.params === "object" ? envelope.params as Record<string, unknown> : {};
    const delta = params.delta ?? params.output;
    return typeof delta === "string" && delta.length > 0 ? method : null;
  }
  if (method === "command/exec/outputDelta") {
    const params = envelope.params && typeof envelope.params === "object" ? envelope.params as Record<string, unknown> : {};
    return typeof params.deltaBase64 === "string" && params.deltaBase64.length > 0 ? method : null;
  }
  return null;
}
