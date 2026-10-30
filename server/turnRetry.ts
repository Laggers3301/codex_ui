import { randomUUID } from "node:crypto";
import { AppError, type PublicAppError } from "./appErrors.js";
import type { ProjectStore } from "./db.js";
import type { RecoveryInspection, TurnInterruption, TurnRecoveryView } from "../shared/turnRecovery.js";

export interface TurnRecoveryState {
  threadId: string; userId: string; error: PublicAppError | null; cancelled?: boolean;
  template: Record<string, unknown> | null;
  activeTurn?: { id: string; startedAt: string; unresolvedTools: string[]; previousTurnId?: string };
  stopRequestedTurnId?: string;
  interruption?: TurnInterruption;
  dismissedTurnId?: string;
  job: null | { id: string; status: "waiting" | "running" | "exhausted"; attempts: number; maxAttempts: number; nextRetryAt: number | null; failedTurnId: string; activeTurnId?: string; ownerRevision: string; resumeOriginal?: boolean };
}
export const publicRecovery = (state: TurnRecoveryState): TurnRecoveryView => ({ threadId: state.threadId, error: state.error, job: state.job ? { status: state.job.status, attempts: state.job.attempts, maxAttempts: state.job.maxAttempts, nextRetryAt: state.job.nextRetryAt } : null,
  ...(state.interruption ? { interruption: state.interruption } : {}), ...(state.dismissedTurnId ? { dismissedTurnId: state.dismissedTurnId } : {}) });

/** A read-only preflight can be retried without resending a generation. */
export class RetryDeferredError extends Error {}
function retryDelay(state: TurnRecoveryState, intervalMs?: number): number {
  return intervalMs ?? (state.error?.code === "stream_disconnected"
    ? Math.min(5_000 * 2 ** Math.min(state.job?.attempts ?? 0, 4), 60_000) : 60_000);
}
export class TurnRetryQueue {
  private timer: ReturnType<typeof setInterval>;
  private draining = false;
  constructor(private store: ProjectStore, private options: {
    start: (state: TurnRecoveryState) => Promise<string | null>;
    busy: (threadId: string) => boolean;
    changed: (state: TurnRecoveryState) => void;
    intervalMs?: number; maxAttempts?: number; tickMs?: number;
  }) {
    // A web-backend restart cannot establish whether an accepted tool finished.
    // Preserve that uncertainty rather than silently discarding or replaying it.
    for (const state of this.store.listTurnRecoveryStates()) {
      const turnId = state.activeTurn?.id ?? (state.job?.status === "running" ? state.job.activeTurnId ?? state.job.failedTurnId : undefined);
      if (!turnId) continue;
      state.error = new AppError("backend_restarted", "服务已重新启动，上一轮的执行结果需要核对。", "检测到重启前尚未收尾的请求或轮次。重启原因未记录，不能据此判断工具是否完成。", false, "backend").toPublic();
      state.interruption = { turnId, source: "backend", unresolvedTools: state.activeTurn?.unresolvedTools ?? [], previousTurnId: state.activeTurn?.previousTurnId };
      state.activeTurn = undefined; state.stopRequestedTurnId = undefined; state.job = null; state.dismissedTurnId = undefined;
      this.save(state);
    }
    this.timer = setInterval(() => void this.drain(), options.tickMs ?? 2500); this.timer.unref?.();
  }
  close() { clearInterval(this.timer); }
  private save(state: TurnRecoveryState) { this.store.setTurnRecoveryState(state); this.options.changed(state); }
  snapshot(userId: string) { return this.store.listTurnRecoveryStates(userId).filter(state => state.error || state.job || state.dismissedTurnId).map(publicRecovery); }
  pending(threadId: string) { const state = this.store.getTurnRecoveryState(threadId); return state?.job?.status === "waiting" || state?.job?.status === "running"; }
  watch(userId: string, threadId: string, params: Record<string, unknown>, previousTurnId?: string) {
    this.save({ userId, threadId, template: params, error: null, job: null, cancelled: false,
      activeTurn: { id: "pending", startedAt: new Date().toISOString(), unresolvedTools: [], previousTurnId } });
  }
  failed(userId: string, threadId: string, turnId: string, error: unknown, eligible: boolean, accepted = true) {
    const state = this.store.getTurnRecoveryState(threadId) ?? { threadId, userId, template: null, job: null, error: null };
    if (state.userId !== userId) return;
    if (state.job?.failedTurnId === turnId && state.job.activeTurnId !== turnId) return;
    if (accepted && state.activeTurn && state.activeTurn.id !== "pending" && state.activeTurn.id !== turnId) return;
    state.error = AppError.from(error).toPublic();
    if (accepted) state.interruption = { turnId, source: state.error.source ?? "unknown", unresolvedTools: state.activeTurn?.unresolvedTools ?? [], previousTurnId: state.activeTurn?.previousTurnId };
    state.activeTurn = undefined; state.stopRequestedTurnId = undefined; state.dismissedTurnId = undefined;
    const owner = this.store.getThreadOwner(threadId);
    if (eligible && !state.cancelled && state.error.retryable && state.template && owner && !this.store.isThreadArchivedLocal(threadId, userId)) {
      const attempts = state.job?.attempts ?? 0, maxAttempts = this.options.maxAttempts ?? 10;
      state.job = { id: randomUUID(), status: attempts >= maxAttempts ? "exhausted" : "waiting", attempts, maxAttempts,
        nextRetryAt: attempts >= maxAttempts ? null : Date.now() + retryDelay(state, this.options.intervalMs), failedTurnId: turnId, ownerRevision: owner.updatedAt,
        resumeOriginal: accepted ? false : state.job?.resumeOriginal ?? true };
    } else state.job = null;
    this.save(state);
  }
  completed(threadId: string, turnId: string) {
    const state = this.store.getTurnRecoveryState(threadId);
    if (!state || (state.activeTurn && state.activeTurn.id !== turnId && state.activeTurn.id !== "pending")
      || (state.interruption && state.interruption.turnId !== turnId && state.job?.activeTurnId !== turnId)) return;
    if (state.job && state.job.activeTurnId !== turnId) return;
    state.job = null; state.error = null; state.activeTurn = undefined; state.interruption = undefined; state.stopRequestedTurnId = undefined; this.save(state);
  }
  started(threadId: string, turnId: string) {
    const owner = this.store.getThreadOwner(threadId);
    if (!owner) return;
    const state = this.store.getTurnRecoveryState(threadId) ?? { threadId, userId: owner.userId, template: null, error: null, job: null };
    if (state.activeTurn?.id === turnId) return;
    if (state.job?.status === "running" && !state.job.activeTurnId) state.job.activeTurnId = turnId;
    else if (state.job && state.job.activeTurnId !== turnId) { state.job = null; state.cancelled = true; }
    if (!state.job) state.error = null;
    state.activeTurn = { id: turnId, startedAt: new Date().toISOString(), unresolvedTools: [] };
    state.interruption = undefined; state.dismissedTurnId = undefined; state.stopRequestedTurnId = undefined;
    this.save(state);
  }
  toolProgress(threadId: string, turnId: string, itemId: string, completed: boolean) {
    const state = this.store.getTurnRecoveryState(threadId);
    if (state?.activeTurn?.id !== turnId) return;
    const tools = new Set(state.activeTurn.unresolvedTools);
    if (completed ? !tools.delete(itemId) : tools.has(itemId)) return;
    if (!completed) tools.add(itemId);
    state.activeTurn.unresolvedTools = [...tools]; this.save(state);
  }
  requestStop(userId: string, threadId: string, turnId: string) {
    const state = this.store.getTurnRecoveryState(threadId);
    if (state?.userId !== userId) return;
    state.stopRequestedTurnId = turnId; this.save(state);
  }
  interrupted(userId: string, threadId: string, turnId: string, error?: unknown) {
    const source = this.store.getTurnRecoveryState(threadId)?.stopRequestedTurnId === turnId ? "user" : "unknown";
    this.failed(userId, threadId, turnId, error ?? new AppError("turn_interrupted",
      source === "user" ? "本轮已按你的停止请求中断，可核对结果后继续。" : "本轮已中断，中断来源尚未确认。",
      source === "user" ? "已记录当前轮次的停止请求。部分工具可能已经执行，请先核对结果。" : "运行时报告 interrupted，但未提供可确认的中断来源。", false, source), false);
  }
  ensureInterruption(userId: string, threadId: string, turnId: string, historicalError?: unknown): TurnRecoveryState {
    const state = this.store.getTurnRecoveryState(threadId) ?? { threadId, userId, template: null, error: null, job: null };
    if (state.userId !== userId) throw new AppError("recovery_unavailable", "会话恢复记录不可访问。");
    if (!state.interruption) {
      if (!turnId) throw new AppError("recovery_unavailable", "没有待核对的中断轮次。");
      const seed = historicalError && typeof historicalError === "object" ? historicalError as Record<string, unknown> : undefined;
      const at = typeof seed?.at === "string" && Number.isFinite(Date.parse(seed.at)) ? seed.at : "";
      state.error ??= { ...(seed ? AppError.from(seed) : new AppError("turn_interrupted", "上一轮执行结果需要核对。", "历史记录没有保留可确认的中断来源。请核对会话和工具结果后继续。")).toPublic(), at };
      state.interruption = { turnId, source: state.error.source ?? "unknown", unresolvedTools: [], requiresReview: true };
      state.dismissedTurnId = undefined; this.save(state);
    }
    if (turnId && state.interruption.turnId !== turnId) throw new AppError("recovery_changed", "恢复记录已更新，请刷新后核对。");
    return state;
  }
  inspected(userId: string, threadId: string, turnId: string, errorAt: string, inspection: RecoveryInspection): boolean {
    const state = this.store.getTurnRecoveryState(threadId);
    if (state?.userId !== userId || state.interruption?.turnId !== turnId || state.error?.at !== errorAt) return false;
    state.interruption.inspection = inspection; this.save(state); return true;
  }
  cancel(userId: string, threadId: string, dismiss = false, turnId?: string) {
    const state = this.store.getTurnRecoveryState(threadId) ?? (dismiss ? { threadId, userId, template: null, error: null, job: null } : null);
    if (!state || state.userId !== userId) return;
    if (dismiss && turnId && state.interruption && state.interruption.turnId !== turnId) return;
    state.job = null; state.cancelled = true;
    if (dismiss) { state.dismissedTurnId = turnId ?? state.interruption?.turnId ?? state.error?.at; state.error = null; state.interruption = undefined; }
    this.save(state);
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
        } catch (error) {
          if (!this.isCurrent(state)) continue;
          const current = this.store.getTurnRecoveryState(state.threadId)!;
          if (error instanceof RetryDeferredError) {
            current.job!.status = "waiting"; current.job!.attempts -= 1;
            current.job!.nextRetryAt = Date.now() + Math.max(5_000, retryDelay(current, this.options.intervalMs));
            this.save(current);
          } else if (current.job!.activeTurnId) {
            current.error = AppError.from(error).toPublic(); this.save(current);
          } else this.failed(state.userId, state.threadId, `pending:${state.job.id}:${state.job.attempts}`, error, true, false);
        }
      }
    } finally { this.draining = false; }
  }
}
