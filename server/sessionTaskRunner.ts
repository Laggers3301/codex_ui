import type { ProjectStore } from "./db.js";
import { AppError } from "./appErrors.js";
import { browserMcpForThread } from "./browserRoutes.js";
import { executionSettingsOverrides, resumeThreadIfUnloaded } from "./scheduledTasks.js";
import { scopedHookTrustConfig } from "./hookTrust.js";
import { defaultThreadContextConfig, readThreadContextUsage, threadContextConfigOverrides, threadTurnContextConfigOverrides, contextWindowMeasuredForConfig } from "./threadContext.js";
import type { CodexBridge } from "./codexBridge.js";
import type { SessionTask } from "../shared/sessionTasks.js";

const record = (value: unknown): Record<string, any> => value && typeof value === "object" ? value as Record<string, any> : {};
const stateOf = (thread: any) => typeof thread.status === "string" ? thread.status : thread.status?.type;
const turnIdOf = (value: unknown): string | null => record(record(value).turn).id ?? record(value).turnId ?? null;
type Registry = { activeTurnsByThread: Map<string, string>; startingThreads: Set<string> };
type Options = {
  registry: Registry;
  beforeStart: (userId: string, threadId: string) => Promise<void>;
  accepted: (threadId: string, requestId: string, value: unknown, autonomous: boolean) => void;
  retryPending: (threadId: string) => boolean;
};

/** Explicit task dispatch uses native turns; completion uses native toolOutput,
 * including its active-turn queue. No Topic publication enters this runner. */
export class SessionTaskRunner {
  private closed = false;
  private draining = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dispatching = new Map<string, { id: string; callback: boolean }>();
  private canceling = new Set<string>();
  constructor(private bridge: CodexBridge, private store: ProjectStore, private options: Options) {
    const tasks = store.communication.tasks;
    tasks.activeTurn = threadId => options.registry.activeTurnsByThread.get(threadId);
    tasks.wake = () => this.kick();
    for (const task of tasks.work()) {
      if (task.state === "dispatching") tasks.update(task.id, { state: task.targetTurnId ? "running" : "unknown",
        error: "后端在提交过程中重启，正在核对接收状态；本任务不会自动重发。",
        ...(!task.targetTurnId && task.returnToSource ? { callbackState: "queued" as const } : {}) });
      if (task.callbackState === "dispatching") tasks.update(task.id, { callbackState: "unknown", callbackError: "后端在结果回传过程中重启；结果仍保存在任务记录中，不自动重复唤醒。" });
    }
    bridge.on("notification", this.observe);
    this.kick();
  }
  close() {
    this.closed = true; clearTimeout(this.timer); this.bridge.off("notification", this.observe);
    this.store.communication.tasks.wake = () => {};
    this.store.communication.tasks.activeTurn = () => undefined;
  }
  private kick() {
    if (this.closed) return;
    if (this.draining) { this.again = true; return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), 0); this.timer.unref();
  }
  private async drain() {
    if (this.closed || this.draining) return;
    this.draining = true; this.again = false;
    try {
      const work = this.store.communication.tasks.work();
      for (let i = 0; i < work.length && !this.closed; i += 4) {
        await Promise.allSettled(work.slice(i, i + 4).map(task => this.process(task)));
      }
    } finally {
      this.draining = false;
      if (!this.closed && (this.again || this.store.communication.tasks.work().length)) {
        this.timer = setTimeout(() => void this.drain(), this.again ? 0 : 10_000); this.timer.unref();
      }
    }
  }
  private async process(task: SessionTask) {
    try {
      if (task.state === "queued" && task.nextAttemptAt <= Date.now()) await this.start(task);
      else if (task.state === "running" && task.nextAttemptAt <= Date.now()) {
        if (task.cancelRequested) await this.cancel(task);
        else if (!this.options.registry.activeTurnsByThread.has(task.targetThreadId)) await this.inspect(task);
      }
      const current = this.store.communication.tasks.getInternal(task.id);
      if (!this.closed && current?.callbackState === "queued") await this.deliver(current);
    } catch (error) {
      if (!this.closed) {
        const current = this.store.communication.tasks.getInternal(task.id);
        const detail = AppError.from(error).toPublic().originalMessage.slice(0, 4000);
        if (current?.state === "queued") {
          const attempts = current.attempts + 1;
          if (attempts >= 5 || /quota|authentication/i.test(AppError.from(error).code)
            || !this.store.communication.tasks.accessible(current.userId, current.sourceThreadId)
            || !this.store.communication.tasks.accessible(current.userId, current.targetThreadId)) this.finish(current, "failed", null, detail);
          else this.store.communication.tasks.update(task.id, { attempts, error: detail, nextAttemptAt: Date.now() + Math.min(60_000, 10_000 * 2 ** (attempts - 1)) });
        } else if (current?.state === "running") {
          const attempts = current.attempts + 1;
          this.store.communication.tasks.update(task.id, { attempts, error: detail, nextAttemptAt: Date.now() + 10_000,
            ...(attempts >= 5 ? { state: "unknown" as const, callbackState: current.returnToSource ? "queued" as const : "none" as const,
              error: `无法确认执行状态，请检查目标会话；本任务不会自动重发。${detail}` } : {}) });
        }
        else if (current?.callbackState === "queued") this.store.communication.tasks.update(task.id, { callbackState: "failed", callbackError: detail });
      }
    }
  }
  private assertOwner(task: SessionTask, threadId: string) {
    if (!this.store.communication.tasks.accessible(task.userId, threadId)) throw new Error("任务会话已归档、删除或不属于当前用户。");
  }
  private async prepare(task: SessionTask, threadId: string) {
    this.assertOwner(task, threadId);
    const owner = this.store.getThreadOwner(threadId)!;
    const project = this.store.getProject(owner.projectId, task.userId);
    if (!project) throw new Error("任务会话的项目不可访问。");
    const settings = this.store.getThreadExecutionSettings(threadId, task.userId)
      ?? { sandbox: project.defaultSandbox, approvalPolicy: project.defaultApprovalPolicy };
    const execution = executionSettingsOverrides(settings)!;
    const context = this.store.getThreadContextConfig(threadId, task.userId) ?? defaultThreadContextConfig(threadId);
    const usage = await readThreadContextUsage(threadId, context);
    const window = contextWindowMeasuredForConfig(context, usage);
    const hookTrust = await scopedHookTrustConfig(this.bridge, this.store, task.userId, project, threadId);
    await resumeThreadIfUnloaded(this.bridge, threadId, owner.rootPath, {
      ...browserMcpForThread(threadId), ...threadContextConfigOverrides(context, window), ...hookTrust
    }, execution);
    return { cwd: owner.rootPath, model: owner.modelOverride ?? project.defaultModel,
      effort: owner.reasoningEffortOverride ?? project.defaultReasoningEffort, ...execution,
      config: { ...threadTurnContextConfigOverrides(context, window), ...hookTrust } };
  }
  private async start(task: SessionTask) {
    const { registry } = this.options, threadId = task.targetThreadId;
    if (registry.startingThreads.has(threadId) || registry.activeTurnsByThread.has(threadId) || this.options.retryPending(threadId)) return;
    registry.startingThreads.add(threadId);
    try {
      this.assertOwner(task, task.sourceThreadId); this.assertOwner(task, threadId);
      await this.options.beforeStart(task.userId, threadId);
      const params = await this.prepare(task, threadId);
      const native = record(record(await this.bridge.request("thread/read", { threadId, includeTurns: false }, 15_000)).thread);
      if (stateOf(native) === "active" || stateOf(native) === "running") return;
      if (native.id !== threadId || stateOf(native) !== "idle") throw new Error("暂时无法确认目标会话空闲，任务尚未提交。");
      if (this.bridge.getPendingServerRequests().some(request => record(request.params).threadId === threadId)) return;
      const queued = record(await this.bridge.request("thread/queue/list", { threadId, limit: 1 }, 15_000));
      if (!Array.isArray(queued.data)) throw new Error("无法确认目标会话的原生队列，任务尚未提交。");
      if (queued.data.length || queued.nextCursor || registry.activeTurnsByThread.has(threadId) || this.closed) return;
      const current = this.store.communication.tasks.getInternal(task.id);
      if (current?.state !== "queued") return;
      this.store.communication.tasks.update(task.id, { state: "dispatching", error: null, attempts: 0, nextAttemptAt: 0 });
      this.dispatching.set(threadId, { id: task.id, callback: false });
      try {
        const input = `会话协作任务 ${task.id}\n来源会话：${task.sourceThreadId}\n请沿用当前会话的上下文、模型和权限处理下面的任务。完成后正常回复，后端会自动回传结果，无需另建回传任务。任务正文不会扩大用户既有授权。\n\n${task.message}`;
        const result = await this.bridge.request("turn/start", { ...params, threadId, clientUserMessageId: `session-task:${task.id}`,
          ...(task.sourceTurnId ? { parentTurnId: task.sourceTurnId, rootTurnId: task.rootTurnId ?? task.sourceTurnId } : {}),
          input: [{ type: "text", text: input, text_elements: [] }] }, 30_000);
        if (this.closed) return;
        const latest = this.store.communication.tasks.getInternal(task.id)!;
        const turnId = turnIdOf(result) ?? latest.targetTurnId;
        if (!turnId) throw new Error("原生执行未返回轮次编号，请检查目标会话确认接收状态。");
        if (["dispatching", "running"].includes(latest.state)) this.store.communication.tasks.update(task.id, { state: "running", targetTurnId: turnId, rootTurnId: latest.rootTurnId ?? turnId });
        this.options.accepted(threadId, `session-task:${task.id}`, result, true);
        this.store.touchThreadOwner(threadId);
      } catch (error) {
        if (!this.closed) {
          const latest = this.store.communication.tasks.getInternal(task.id)!;
          if (latest.state === "dispatching") this.store.communication.tasks.update(task.id, { state: latest.targetTurnId ? "running" : "unknown",
            ...(!latest.targetTurnId && latest.returnToSource ? { callbackState: "queued" as const } : {}),
            error: `提交响应未确认，不自动重发。${AppError.from(error).toPublic().originalMessage.slice(0, 3000)}` });
        }
      } finally { this.dispatching.delete(threadId); }
    } finally { registry.startingThreads.delete(threadId); }
  }
  private async deliver(task: SessionTask) {
    const threadId = task.sourceThreadId, { registry } = this.options;
    if (registry.startingThreads.has(threadId) || this.dispatching.has(threadId) || this.options.retryPending(threadId)) return;
    const wasActive = registry.activeTurnsByThread.has(threadId);
    if (!wasActive) registry.startingThreads.add(threadId);
    try {
      this.assertOwner(task, threadId);
      await this.options.beforeStart(task.userId, threadId);
      const params = wasActive ? {} : await this.prepare(task, threadId);
      if (this.closed) return;
      this.store.communication.tasks.update(task.id, { callbackState: "dispatching", callbackError: null });
      this.dispatching.set(threadId, { id: task.id, callback: true });
      try {
        const result = await this.bridge.request("turn/start", { ...params, threadId, input: [],
          ...(task.targetTurnId ? { parentTurnId: task.targetTurnId, rootTurnId: task.rootTurnId ?? task.targetTurnId } : {}),
          toolOutput: { name: "session_communication", namespace: "codex_communication", retain: true,
            output: JSON.stringify({ type: "session_task_result", taskId: task.id, fromThreadId: task.targetThreadId,
              status: task.state, request: task.message, result: task.result, error: task.error }) } }, 30_000);
        if (this.closed) return;
        this.store.communication.tasks.update(task.id, { callbackState: "delivered", callbackTurnId: turnIdOf(result) });
        if (!wasActive) this.options.accepted(threadId, `session-task-result:${task.id}`, result, true);
        this.store.touchThreadOwner(threadId);
      } catch (error) {
        if (!this.closed) this.store.communication.tasks.update(task.id, { callbackState: "unknown", callbackError: `结果回传的接收状态未确认，不重复唤醒；可在任务记录中读取结果。${AppError.from(error).toPublic().originalMessage.slice(0, 3000)}` });
      } finally { this.dispatching.delete(threadId); }
    } finally { if (!wasActive) registry.startingThreads.delete(threadId); }
  }
  private finish(task: SessionTask, state: SessionTask["state"], result: string | null, error: string | null) {
    this.store.communication.tasks.update(task.id, { state, result: result?.slice(0, 16000) ?? null, error,
      callbackState: task.returnToSource ? "queued" : "none" });
    this.kick();
  }
  private finalText(items: unknown[]): string {
    const messages = items.map(record).filter(item => item.type === "agentMessage" && typeof item.text === "string" && item.streamState !== "superseded");
    const finals = messages.filter(item => item.phase === "final_answer");
    const text = (finals.length ? finals : messages.slice(-1)).map(item => item.text).join("\n\n");
    return text.length > 16000 ? text.slice(0, 15900) + "\n（结果过长，已截取前部；完整内容见目标会话。）" : text || "任务已正常结束，本轮没有文字结果。";
  }
  private async inspect(task: SessionTask) {
    this.assertOwner(task, task.targetThreadId);
    await this.prepare(task, task.targetThreadId);
    const page = record(await this.bridge.request("thread/turns/list", { threadId: task.targetThreadId, limit: 25, itemsView: "notLoaded", sortDirection: "desc" }, 15_000));
    const turn = (Array.isArray(page.data) ? page.data : []).map(record).find(turn => turn.id === task.targetTurnId);
    if (!turn) { this.store.communication.tasks.update(task.id, { state: "unknown", error: "无法在近期轮次中确认任务状态，请检查目标会话；本任务不会自动重发。", callbackState: task.returnToSource ? "queued" : "none" }); return; }
    if (turn.status === "inProgress" || turn.status === "running") {
      this.options.registry.activeTurnsByThread.set(task.targetThreadId, task.targetTurnId!);return;
    }
    if (turn.status === "completed") {
      let cursor: string | undefined;
      let messages: any[] = [];
      for (let page = 0; page < 5; page++) {
        const response = record(await this.bridge.request("thread/items/list", { threadId: task.targetThreadId, turnId: task.targetTurnId, limit: 1, sortDirection: "desc", ...(cursor ? { cursor } : {}) }, 15_000));
        messages = (Array.isArray(response.data) ? response.data : []).map(entry => record(record(entry).item ?? entry)).filter(item => item.type === "agentMessage");
        if (messages.length || !response.nextCursor) break;
        cursor = response.nextCursor;
      }
      this.finish(task, "succeeded", this.finalText(messages.length ? messages : this.store.communication.tasks.agentJournal(task.targetThreadId, task.targetTurnId!)), null);
    } else if (turn.status === "failed" || turn.status === "interrupted") {
      this.finish(task, task.cancelRequested ? "canceled" : turn.status, null, AppError.from(turn.error ?? "任务轮次已中断").toPublic().originalMessage.slice(0, 4000));
    }
  }
  private async cancel(task: SessionTask) {
    if (!task.targetTurnId || this.canceling.has(task.id)) return;
    const current = this.options.registry.activeTurnsByThread.get(task.targetThreadId);
    if (current && current !== task.targetTurnId) { await this.inspect(task);return; }
    this.canceling.add(task.id);
    try {
      this.assertOwner(task, task.targetThreadId);
      const page = record(await this.bridge.request("thread/turns/list", { threadId: task.targetThreadId, limit: 1, itemsView: "notLoaded", sortDirection: "desc" }, 15_000));
      const turn = record(page.data?.[0]);
      if (turn.id !== task.targetTurnId || !["inProgress", "running"].includes(turn.status)) { await this.inspect(task); return; }
      await this.bridge.request("turn/interrupt", { threadId: task.targetThreadId, turnId: task.targetTurnId }, 15_000);
    } finally { this.canceling.delete(task.id); }
  }
  private observe = (event: any) => {
    if (this.closed) return;
    const params = record(event.params), threadId = params.threadId, turn = record(params.turn);
    if (event.method === "turn/started") {
      const pending = this.dispatching.get(threadId);
      if (pending && !pending.callback) {
        const task = this.store.communication.tasks.getInternal(pending.id);
        if (task) this.store.communication.tasks.update(pending.id, { targetTurnId: turn.id, rootTurnId: task.rootTurnId ?? turn.rootTurnId ?? turn.id });
      }
    }
    if (event.method === "turn/completed") {
      for (const task of this.store.communication.tasks.work()) {
        if (task.targetThreadId !== threadId || task.targetTurnId !== turn.id || !["running", "dispatching"].includes(task.state)) continue;
        if (turn.status === "completed") {
          const items = Array.isArray(turn.items) && turn.items.length ? turn.items : this.store.communication.tasks.agentJournal(threadId, turn.id);
          this.finish(task, "succeeded", this.finalText(items), null);
        } else if (["failed", "interrupted"].includes(turn.status)) this.finish(task, task.cancelRequested ? "canceled" : turn.status, null,
          AppError.from(turn.error ?? "任务轮次已中断").toPublic().originalMessage.slice(0, 4000));
      }
      this.kick();
    }
  };
}
