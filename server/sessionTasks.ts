import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ProjectStore } from "./db.js";
import type { SessionTask, SessionTaskTarget } from "../shared/sessionTasks.js";

export class SessionTaskError extends Error { constructor(message: string, readonly statusCode = 409) { super(message); } }
export const taskSendSchema = z.object({ operation: z.literal("task.send"), requestId: z.string().min(6).max(128),
  targetThreadId: z.string().min(1).max(128), message: z.string().trim().min(1).max(16000), returnToSource: z.boolean().default(true) }).strict();
export const taskCancelSchema = z.object({ operation: z.literal("task.cancel"), requestId: z.string().min(6).max(128), id: z.string().min(1).max(128) }).strict();
const ended = new Set(["succeeded", "failed", "interrupted", "canceled"]);
type TaskRow = { data: string; digest: string };

/** Durable, explicitly addressed work; Topic/Service/Action delivery remains passive. */
export class SessionTaskStore {
  activeTurn: (threadId: string) => string | undefined = () => undefined;
  wake: () => void = () => {};
  constructor(private db: DatabaseSync, private owners: ProjectStore, private changed: (userId: string, threadIds: string[]) => void) {
    db.exec(`CREATE TABLE IF NOT EXISTS communication_tasks (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_thread_id TEXT NOT NULL,target_thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL,callback_state TEXT NOT NULL,data TEXT NOT NULL,
      UNIQUE(user_id,source_thread_id,request_id)
    ); CREATE INDEX IF NOT EXISTS communication_task_work ON communication_tasks(state,callback_state);
    CREATE INDEX IF NOT EXISTS communication_task_source ON communication_tasks(user_id,source_thread_id);
    CREATE INDEX IF NOT EXISTS communication_task_target ON communication_tasks(user_id,target_thread_id);`);
  }
  accessible(userId: string, threadId: string) {
    return this.owners.userCanAccessThread(threadId, userId) && !this.owners.isThreadArchivedLocal(threadId, userId);
  }
  private assertAccess(userId: string, threadId: string) {
    if (!this.accessible(userId, threadId)) throw new SessionTaskError("会话不存在、已归档或不属于当前用户。", 403);
  }
  private name(userId: string, threadId: string) {
    const owner = this.owners.getThreadOwner(threadId);
    return owner?.userId === userId ? owner.displayName || threadId : "已不可访问的会话";
  }
  private present(task: SessionTask): SessionTask {
    const href = (threadId: string) => {
      const owner = this.owners.getThreadOwner(threadId);
      return owner?.userId === task.userId ? `/?project=${encodeURIComponent(owner.projectId)}&thread=${encodeURIComponent(this.owners.sideChats.forThread(threadId)?.parentThreadId ?? threadId)}` : undefined;
    };
    return { ...task, sourceThreadName: this.name(task.userId, task.sourceThreadId), targetThreadName: this.name(task.userId, task.targetThreadId),
      sourceHref: href(task.sourceThreadId), targetHref: href(task.targetThreadId) };
  }
  targets(userId: string, sourceThreadId: string, query = ""): SessionTaskTarget[] {
    this.assertAccess(userId, sourceThreadId);
    const search = query.trim().toLocaleLowerCase();
    return this.owners.listVisibleThreadOwnersForUser(userId).filter(owner => owner.threadId !== sourceThreadId
      && this.accessible(userId, owner.threadId) && (!search || `${owner.threadId} ${owner.displayName ?? ""}`.toLocaleLowerCase().includes(search)))
      .slice(0, 100).flatMap(owner => {
        const project = this.owners.getProject(owner.projectId, userId);
        return project ? [{ threadId: owner.threadId, name: owner.displayName || owner.threadId, projectName: project.name, model: owner.modelOverride || project.defaultModel }] : [];
      });
  }
  getInternal(id: string): SessionTask | null {
    const row = this.db.prepare("SELECT data FROM communication_tasks WHERE id=?").get(id) as TaskRow | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  get(userId: string, threadId: string, id: string): SessionTask {
    this.assertAccess(userId, threadId);
    const task = this.getInternal(id);
    if (!task || task.userId !== userId || ![task.sourceThreadId, task.targetThreadId].includes(threadId)) throw new SessionTaskError("任务不存在或当前会话无权读取。", 404);
    return this.present(task);
  }
  list(userId: string, threadId: string): SessionTask[] {
    this.assertAccess(userId, threadId);
    return (this.db.prepare(`SELECT data FROM communication_tasks WHERE user_id=? AND (source_thread_id=? OR target_thread_id=?)
      ORDER BY CASE WHEN state IN ('queued','dispatching','running','unknown') THEN 0 ELSE 1 END,rowid DESC LIMIT 25`)
      .all(userId, threadId, threadId) as TaskRow[]).map(row => this.present(JSON.parse(row.data)));
  }
  work(): SessionTask[] {
    return (this.db.prepare(`SELECT data FROM communication_tasks WHERE state IN ('queued','dispatching','running')
      OR callback_state IN ('queued','dispatching') ORDER BY rowid LIMIT 200`).all() as TaskRow[]).map(row => JSON.parse(row.data));
  }
  agentJournal(threadId: string, turnId: string): unknown[] {
    // Read only bounded assistant text, never a turn's potentially huge tool
    // outputs. Native history remains the recovery authority after restart.
    return (this.db.prepare(`SELECT substr(json_extract(item_json,'$.text'),1,16001) AS text
      FROM conversation_timeline WHERE thread_id=? AND turn_id=? AND json_extract(item_json,'$.type')='agentMessage'
      AND COALESCE(json_extract(item_json,'$.streamState'),'')!='superseded' ORDER BY rowid DESC LIMIT 5`)
      .all(threadId, turnId) as Array<{ text: string }>).reverse().map(row => ({ type: "agentMessage", text: row.text }));
  }
  update(id: string, patch: Partial<SessionTask>): SessionTask | null {
    const current = this.getInternal(id); if (!current) return null;
    const task = { ...current, ...patch, id, updatedAt: new Date().toISOString() };
    this.db.prepare("UPDATE communication_tasks SET state=?,callback_state=?,data=? WHERE id=?")
      .run(task.state, task.callbackState, JSON.stringify(task), id);
    this.changed(task.userId, [task.sourceThreadId, task.targetThreadId]);
    return task;
  }
  send(userId: string, sourceThreadId: string, input: unknown): SessionTask {
    this.assertAccess(userId, sourceThreadId);
    const command = taskSendSchema.parse(input);
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const receipt = this.db.prepare("SELECT data,digest FROM communication_tasks WHERE user_id=? AND source_thread_id=? AND request_id=?")
      .get(userId, sourceThreadId, command.requestId) as TaskRow | undefined;
    if (receipt) {
      if (receipt.digest !== digest) throw new SessionTaskError("该请求编号已用于其他内容，请更换请求编号。");
      return this.present(JSON.parse(receipt.data));
    }
    this.assertAccess(userId, command.targetThreadId);
    if (sourceThreadId === command.targetThreadId) throw new SessionTaskError("请选择另一个会话执行任务。");
    const active = (this.db.prepare("SELECT data FROM communication_tasks WHERE user_id=? AND state IN ('queued','dispatching','running','unknown')").all(userId) as TaskRow[]).map(row => JSON.parse(row.data) as SessionTask);
    if (active.length >= 50 || active.filter(task => task.targetThreadId === command.targetThreadId).length >= 10) throw new SessionTaskError("未结束任务已达到上限，请处理后再派发。", 429);
    const seen = new Set<string>();
    const reaches = (from: string): boolean => {
      if (from === sourceThreadId) return true;
      if (seen.has(from)) return false; seen.add(from);
      return active.filter(task => task.sourceThreadId === from).some(task => reaches(task.targetThreadId));
    };
    if (reaches(command.targetThreadId)) throw new SessionTaskError("该任务会形成相互等待的循环，请先结束已有任务。");
    const activeTurnId = this.activeTurn(sourceThreadId);
    const sourceTurnId = activeTurnId && !activeTurnId.startsWith("pending:") ? activeTurnId : null;
    const parent = sourceTurnId ? (this.db.prepare("SELECT data FROM communication_tasks WHERE user_id=? ORDER BY rowid DESC LIMIT 100").all(userId) as TaskRow[])
      .map(row => JSON.parse(row.data) as SessionTask).find(task => (task.targetThreadId === sourceThreadId && task.targetTurnId === sourceTurnId)
        || (task.sourceThreadId === sourceThreadId && task.callbackTurnId === sourceTurnId)) : undefined;
    if (parent && parent.depth >= 4) throw new SessionTaskError("自动派发链已达到 4 层，请结束当前协作后再发起新任务。");
    const now = new Date().toISOString();
    const task: SessionTask = { id: randomUUID(), userId, sourceThreadId, targetThreadId: command.targetThreadId,
      sourceThreadName: "", targetThreadName: "", message: command.message, state: "queued", result: null, error: null,
      targetTurnId: null, sourceTurnId, callbackTurnId: null, callbackState: "none", callbackError: null,
      returnToSource: command.returnToSource, cancelRequested: false, parentTaskId: parent?.id ?? null,
      rootTurnId: parent?.rootTurnId ?? sourceTurnId, depth: parent ? parent.depth + 1 : 1,
      attempts: 0, nextAttemptAt: 0, createdAt: now, updatedAt: now };
    this.db.prepare("INSERT INTO communication_tasks(id,user_id,source_thread_id,target_thread_id,request_id,digest,state,callback_state,data) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(task.id, userId, sourceThreadId, task.targetThreadId, command.requestId, digest, task.state, task.callbackState, JSON.stringify(task));
    this.changed(userId, [sourceThreadId, task.targetThreadId]); this.wake();
    return this.present(task);
  }
  cancel(userId: string, threadId: string, input: unknown): SessionTask {
    const command = taskCancelSchema.parse(input), task = this.get(userId, threadId, command.id);
    if (ended.has(task.state)) return task;
    if (task.state === "unknown") throw new SessionTaskError("执行请求的接收结果尚未确认，请先检查目标会话，避免中断其他任务。");
    this.update(task.id, task.state === "queued" ? { state: "canceled", callbackState: task.returnToSource ? "queued" : "none", result: "任务在开始执行前已取消。", cancelRequested: true }
      : { cancelRequested: true });
    this.wake(); return this.get(userId, threadId, task.id);
  }
}
