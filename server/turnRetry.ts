import { randomUUID } from "node:crypto";
import { AppError, type PublicAppError } from "./appErrors.js";
import type { ProjectStore } from "./db.js";

export interface TurnRecoveryState {
  threadId: string; userId: string; error: PublicAppError | null; cancelled?: boolean;
  template: Record<string, unknown> | null;
  job: null | { id: string; status: "waiting" | "running" | "exhausted"; attempts: number; maxAttempts: number; nextRetryAt: number | null; failedTurnId: string; activeTurnId?: string; ownerRevision: string; resumeOriginal?: boolean };
}
export const publicRecovery = (state: TurnRecoveryState) => ({ threadId: state.threadId, error: state.error, job: state.job ? { status: state.job.status, attempts: state.job.attempts, maxAttempts: state.job.maxAttempts, nextRetryAt: state.job.nextRetryAt } : null });

export class TurnRetryQueue {
  private timer: ReturnType<typeof setInterval>;
  private draining = false;
  constructor(private store: ProjectStore, private options: {
    start: (state: TurnRecoveryState) => Promise<string | null>;
    busy: (threadId: string) => boolean;
    changed: (state: TurnRecoveryState) => void;
    intervalMs?: number; maxAttempts?: number; tickMs?: number;
  }) {
    // Never replay a request that may already have been accepted before restart.
    for (const state of this.store.listTurnRecoveryStates()) if (state.job?.status === "running") { state.job = null; this.save(state); }
    this.timer = setInterval(() => void this.drain(), options.tickMs ?? 2500); this.timer.unref?.();
  }
  close() { clearInterval(this.timer); }
  private save(state: TurnRecoveryState) { this.store.setTurnRecoveryState(state); this.options.changed(state); }
  snapshot(userId: string) { return this.store.listTurnRecoveryStates(userId).filter(state => state.error || state.job).map(publicRecovery); }
  pending(threadId: string) { const state = this.store.getTurnRecoveryState(threadId); return state?.job?.status === "waiting" || state?.job?.status === "running"; }
  watch(userId: string, threadId: string, params: Record<string, unknown>) {
    this.save({ userId, threadId, template: params, error: null, job: null, cancelled: false });
  }
  failed(userId: string, threadId: string, turnId: string, error: unknown, eligible: boolean, accepted = true) {
    const state = this.store.getTurnRecoveryState(threadId) ?? { threadId, userId, template: null, job: null, error: null };
    if (state.userId !== userId) return;
    state.error = AppError.from(error).toPublic();
    const owner = this.store.getThreadOwner(threadId);
    if (eligible && !state.cancelled && state.error.retryable && state.template && owner && !this.store.isThreadArchivedLocal(threadId, userId)) {
      const attempts = state.job?.attempts ?? 0, maxAttempts = this.options.maxAttempts ?? 10;
      state.job = { id: randomUUID(), status: attempts >= maxAttempts ? "exhausted" : "waiting", attempts, maxAttempts,
        nextRetryAt: attempts >= maxAttempts ? null : Date.now() + (this.options.intervalMs ?? 60_000), failedTurnId: turnId, ownerRevision: owner.updatedAt,
        resumeOriginal: accepted ? false : state.job?.resumeOriginal ?? true };
    } else state.job = null;
    this.save(state);
  }
  completed(threadId: string, turnId: string) {
    const state = this.store.getTurnRecoveryState(threadId);
    if (!state || !state.job || state.job.activeTurnId !== turnId) return;
    state.job = null; state.error = null; this.save(state);
  }
  started(threadId: string, turnId: string) {
    const state = this.store.getTurnRecoveryState(threadId);
    if (!state?.job) return;
    if (state.job.status === "running" && !state.job.activeTurnId) { state.job.activeTurnId = turnId; this.save(state); }
    else if (state.job.activeTurnId !== turnId) this.cancel(state.userId, threadId);
  }
  cancel(userId: string, threadId: string, dismiss = false) {
    const state = this.store.getTurnRecoveryState(threadId);
    if (!state || state.userId !== userId) return;
    state.job = null; state.cancelled = true; if (dismiss) state.error = null; this.save(state);
  }
  retryNow(userId: string, threadId: string) {
    const state = this.store.getTurnRecoveryState(threadId);
    if (!state || state.userId !== userId || state.job?.status !== "waiting") throw new AppError("retry_unavailable", "当前没有待重试的任务。");
    state.job.nextRetryAt = Date.now(); this.save(state); void this.drain();
  }
  isCurrent(state: TurnRecoveryState) { return this.store.getTurnRecoveryState(state.threadId)?.job?.id === state.job?.id; }
  async drain() {
    if (this.draining) return; this.draining = true;
    try {
      for (const state of this.store.listTurnRecoveryStates()) {
        if (state.job?.status !== "waiting" || (state.job.nextRetryAt ?? Infinity) > Date.now() || this.options.busy(state.threadId)) continue;
        const owner = this.store.getThreadOwner(state.threadId);
        if (!owner || owner.userId !== state.userId || this.store.isThreadArchivedLocal(state.threadId, state.userId) || owner.updatedAt !== state.job.ownerRevision) { this.cancel(state.userId, state.threadId); continue; }
        state.job.status = "running"; state.job.attempts += 1; state.job.nextRetryAt = null; this.save(state);
        try {
          const turnId = await this.options.start(state);
          if (this.isCurrent(state)) {
            const current = this.store.getTurnRecoveryState(state.threadId)!;
            if (turnId) { current.job!.activeTurnId = turnId; this.save(current); }
            else this.cancel(state.userId, state.threadId);
          }
        } catch (error) { if (this.isCurrent(state)) this.failed(state.userId, state.threadId, state.job.failedTurnId, error, true, false); }
      }
    } finally { this.draining = false; }
  }
}
