import { AppError } from "./appErrors.js";
import type { CodexBridge } from "./codexBridge.js";
import type { ProjectStore } from "./db.js";
import type { RequestDeduper } from "./requestDeduper.js";
import { publicRecovery, type TurnRecoveryState, type TurnRetryQueue } from "./turnRetry.js";
import type { RecoveryInspection } from "../shared/turnRecovery.js";
import { browserMcpForThread } from "./browserRoutes.js";
import { executionSettingsOverrides, resumeThreadIfUnloaded } from "./scheduledTasks.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const result = (status: RecoveryInspection["status"], message: string): RecoveryInspection => ({ status, message, at: new Date().toISOString() });

/** Read metadata only. A quiet actor is not proof that its tools succeeded. */
export async function inspectTurnRecovery(bridge: CodexBridge, state: TurnRecoveryState): Promise<RecoveryInspection> {
  const response = record(await bridge.request("thread/read", { threadId: state.threadId, includeTurns: false }, 10_000));
  const thread = record(response.thread), status = record(thread.status);
  const phase = typeof thread.status === "string" ? thread.status : status.type;
  const pending = bridge.getPendingServerRequests().some(request => {
    const params = record(request.params);
    return params.threadId === state.threadId && params.isBlocking !== false;
  });
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags.map(flag => typeof flag === "string" ? flag : record(flag).type) : [];
  if (pending || flags.some(flag => /approval|userinput/i.test(String(flag)))) return result("waiting", "会话仍在等待回答或批准，请先处理待办问题。");
  if (phase === "active" || phase === "running") return result("running", "会话仍在运行，请等待当前轮次结束；本次核对没有发送新消息。");
  if (!["idle", "systemError", "notLoaded"].includes(String(phase))) return result("unknown", "暂时无法确认会话状态，尚未发送恢复请求，请稍后重新核对。");
  const queued = record(await bridge.request("thread/queue/list", { threadId: state.threadId, limit: 1 }, 10_000));
  if (!Array.isArray(queued.data)) return result("unknown", "未能确认排队消息的状态，尚未发送恢复请求。");
  if (queued.data.length || queued.nextCursor) return result("waiting", "会话还有排队消息，请先查看排队内容后再决定是否恢复。");
  if (thread.historyMode !== "paginated") return result("needs_review", "会话当前空闲，但旧版历史不能自动核对最后一轮结果。请先查看会话及工具记录，确认后再继续。");
  const latest = record(await bridge.request("thread/turns/list", { threadId: state.threadId, limit: 1, itemsView: "notLoaded", sortDirection: "desc" }, 10_000));
  const turn = record(Array.isArray(latest.data) ? latest.data[0] : undefined);
  const interruption = state.interruption!;
  if (!turn.id) return result("unknown", "未找到可核对的最后一轮记录，尚未发送恢复请求。");
  if (interruption.turnId.startsWith("pending")) {
    if (interruption.previousTurnId && turn.id !== interruption.previousTurnId) return result("changed", "上次提交后已有新的轮次记录，请先查看该轮结果，避免重复恢复。");
    return result("needs_review", "上一轮的接收结果未确认。请先查看最后一轮和工具记录，确认实际执行情况后再继续。");
  }
  if (turn.id !== interruption.turnId) return result("changed", "会话已有更新的轮次，请查看最新结果；本次核对没有重新发送原任务。");
  if (turn.status === "completed") return result("completed", "已核对：上一轮正常结束，无需再次恢复。");
  if (turn.status !== "failed" && turn.status !== "interrupted") return result("unknown", "最后一轮尚未进入明确的结束状态，尚未发送恢复请求。");
  if (interruption.unresolvedTools.length) return result("needs_review", `中断前有 ${interruption.unresolvedTools.length} 个工具未收到完成结果。请先核对这些操作的实际结果，确认后再继续。`);
  if (interruption.requiresReview) return result("needs_review", "历史记录未保留完整的工具完成状态，请先核对上一轮的实际结果，确认后再继续。");
  return result("ready", "已核对：上一轮已结束，会话当前空闲。可以沿用现有记录继续，恢复消息会要求先核对已完成的步骤。");
}

export const interruptionContinuation = "请先核对上一轮的实际执行结果，再在当前会话继续未完成的原任务。沿用原始指令、授权范围和当前模型，保留已完成的步骤。结果不明的工具先查状态与输出，确认失败或尚未执行后才重试；任务已完成时直接报告结果，不重新开始整个任务。";

type RecoveryGuards = {
  requestDeduper: RequestDeduper;
  activeTurnsByThread: Map<string, string>;
  startingThreads: Set<string>;
};

export async function runTurnRecovery(options: {
  bridge: CodexBridge; store: ProjectStore; retries: TurnRetryQueue; guards: RecoveryGuards;
  userId: string; threadId: string; turnId: string; errorAt?: string; requestId: string;
  historicalError?: unknown;
  action: "check" | "continue"; toolsReviewed: boolean;
  beforeContinue: () => Promise<void>;
  accepted: (value: unknown) => void;
}) {
  const { bridge, store, retries, guards, userId, threadId, turnId, requestId } = options;
  return guards.requestDeduper.run({ userId, requestId }, async () => {
    const owner = store.getThreadOwner(threadId);
    if (owner?.userId !== userId || !store.userCanAccessThread(threadId, userId) || store.isThreadArchivedLocal(threadId, userId)) throw new AppError("recovery_unavailable", "会话恢复记录不可访问。");
    if ((guards.startingThreads.has(threadId) || guards.activeTurnsByThread.has(threadId)) && !store.getTurnRecoveryState(threadId)?.interruption) {
      throw new AppError("recovery_busy", "会话已有新的轮次，本次恢复未提交。请查看最新记录。");
    }
    const state = retries.ensureInterruption(userId, threadId, turnId, options.historicalError);
    if (options.errorAt !== undefined && options.errorAt !== state.error?.at) throw new AppError("recovery_changed", "错误记录已更新，请重新核对后再继续。");
    if (state.job?.status === "waiting" || state.job?.status === "running") throw new AppError("recovery_busy", "当前有自动重试任务，请先等待或取消自动重试。");
    if (guards.startingThreads.has(threadId) || guards.activeTurnsByThread.has(threadId)) {
      const inspection = result("running", "会话已有正在启动或运行的轮次，请等待它结束。");
      retries.inspected(userId, threadId, state.interruption!.turnId, state.error!.at, inspection);
      if (options.action === "continue") throw new AppError("recovery_busy", inspection.message);
      return publicRecovery(store.getTurnRecoveryState(threadId)!);
    }
    guards.startingThreads.add(threadId);
    try {
      const incident = state.interruption!, errorAt = state.error!.at;
      retries.inspected(userId, threadId, incident.turnId, errorAt, result("checking", "正在核对运行状态与最后一轮记录，本次核对不会发送新消息。"));
      let inspection: RecoveryInspection;
      try { inspection = await inspectTurnRecovery(bridge, state); }
      catch (error) { inspection = result("unknown", `核对未完成，尚未发送恢复请求。${AppError.from(error).toPublic().originalMessage}`); }
      if (!retries.inspected(userId, threadId, incident.turnId, errorAt, inspection)) throw new AppError("recovery_changed", "会话已更新，本次恢复未提交。请查看最新记录。");
      if (options.action === "check") return publicRecovery(store.getTurnRecoveryState(threadId)!);
      if (inspection.status !== "ready" && !(inspection.status === "needs_review" && options.toolsReviewed)) throw new AppError("recovery_not_ready", inspection.message);
      await options.beforeContinue();
      const current = store.getTurnRecoveryState(threadId);
      if (current?.interruption?.turnId !== incident.turnId || current.error?.at !== errorAt || guards.activeTurnsByThread.has(threadId)) throw new AppError("recovery_changed", "会话已更新，本次恢复未提交。请查看最新记录。");
      const execution = store.getThreadExecutionSettings(threadId, userId);
      const currentOwner = store.getThreadOwner(threadId)!;
      const model = currentOwner.modelOverride ?? state.template?.model;
      const effort = currentOwner.reasoningEffortOverride ?? state.template?.effort;
      await resumeThreadIfUnloaded(bridge, threadId, owner.rootPath,
        { ...record(state.template?.config), ...browserMcpForThread(threadId) }, executionSettingsOverrides(execution));
      if (store.getTurnRecoveryState(threadId)?.error?.at !== errorAt || guards.activeTurnsByThread.has(threadId)) throw new AppError("recovery_changed", "会话已更新，本次恢复未提交。");
      const params: Record<string, unknown> = { ...state.template, threadId, model, effort, input: [{ type: "text", text: interruptionContinuation, text_elements: [] }],
        ...(execution ? { approvalPolicy: execution.approvalPolicy } : {}) };
      // Inherit the freshly resumed sandbox instead of restoring an older,
      // potentially more permissive policy from the failed request template.
      delete params.sandboxPolicy;
      if (params.collaborationMode) {
        const mode = record(params.collaborationMode);
        params.collaborationMode = { ...mode, settings: { ...record(mode.settings), ...(model ? { model } : {}), ...(effort ? { reasoning_effort: effort } : {}) } };
      }
      retries.watch(userId, threadId, params, incident.turnId);
      try {
        const started = await bridge.request("turn/start", params, 30_000);
        options.accepted(started);
        store.touchThreadOwner(threadId);
        return { started: true };
      } catch (error) {
        // A missing response is not evidence that native rejected the request.
        if (store.getTurnRecoveryState(threadId)?.activeTurn?.id === "pending") retries.failed(userId, threadId, `pending:${requestId}`,
          new AppError("recovery_start_unconfirmed", "恢复请求的接收结果未确认，请先核对状态，避免重复发送。", AppError.from(error).toPublic().originalMessage), false);
        throw error;
      }
    } catch (error) {
      const appError = AppError.from(error);
      if (!["recovery_changed", "recovery_not_ready"].includes(appError.code)) {
        retries.inspected(userId, threadId, state.interruption!.turnId, state.error!.at,
          result("unknown", `恢复未提交或未能确认，请查看详情后重新核对。${appError.toPublic().originalMessage}`));
      }
      throw error;
    } finally { guards.startingThreads.delete(threadId); }
  }, { serializeKey: `thread:${threadId}` });
}
