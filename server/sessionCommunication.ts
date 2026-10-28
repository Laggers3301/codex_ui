import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ProjectStore } from "./db.js";
import type { CommunicationBinding, CommunicationCommand, CommunicationKind, CommunicationMessage, CommunicationSnapshot, CommunicationState } from "../shared/sessionCommunication.js";

export class CommunicationError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}
const name = z.string().trim().min(1).max(120).regex(/^\/?[a-zA-Z0-9_][a-zA-Z0-9_/.\-]*$/, "名称只能包含字母、数字、下划线、点、横线和斜杠").transform(value => "/" + value.replace(/^\/+|\/+$/g, ""));
const message = z.string().trim().min(1).max(16_000);
const requestId = z.string().min(6).max(128);
const id = z.string().min(1).max(128);
const base = { requestId };
export const communicationCommandSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.enum(["topic.subscribe", "topic.unsubscribe", "service.advertise", "service.unadvertise", "action.advertise", "action.unadvertise"]), name }).strict(),
  z.object({ ...base, operation: z.literal("topic.publish"), name, message }).strict(),
  z.object({ ...base, operation: z.literal("service.call"), name, message, timeoutSeconds: z.number().int().min(1).max(3600).default(120) }).strict(),
  z.object({ ...base, operation: z.literal("service.respond"), id, result: message, success: z.boolean() }).strict(),
  z.object({ ...base, operation: z.literal("action.send"), name, message, timeoutSeconds: z.number().int().min(1).max(3600).default(300) }).strict(),
  z.object({ ...base, operation: z.literal("action.update"), id, status: z.enum(["accepted", "executing", "succeeded", "failed", "rejected", "canceled"]), message: z.string().trim().max(4000).optional(), progress: z.number().min(0).max(100).optional() }).strict(),
  z.object({ ...base, operation: z.literal("action.cancel"), id }).strict(),
  z.object({ ...base, operation: z.literal("inbox.ack"), id }).strict()
]);
type Row = Omit<CommunicationMessage, "sourceThreadName" | "targetThreadName" | "feedback" | "unread"> & { feedbackJson: string; readAt?: string | null };
const columns = `m.id,m.kind,m.name,m.source_thread_id AS sourceThreadId,m.target_thread_id AS targetThreadId,
  m.state,m.message,m.result,m.progress,m.feedback_json AS feedbackJson,m.created_at AS createdAt,m.updated_at AS updatedAt,m.deadline_at AS deadlineAt`;
const terminal = new Set<CommunicationState>(["succeeded", "failed", "rejected", "canceled", "timed_out"]);
export type CommunicationChange = { userId: string; threadIds: string[] };

/** A per-user, persisted message bus. It never starts a model turn or a process.
 * Providers explicitly register and consume work through their own inbox. */
export class SessionCommunicationStore extends EventEmitter {
  constructor(private db: DatabaseSync, private owners: ProjectStore, private clock: () => number = Date.now) {
    super();
    db.exec(`CREATE TABLE IF NOT EXISTS communication_bindings (
      user_id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,thread_id TEXT NOT NULL,
      PRIMARY KEY(user_id,kind,name,thread_id),FOREIGN KEY(thread_id) REFERENCES thread_owners(thread_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS communication_single_provider ON communication_bindings(user_id,kind,name) WHERE kind != 'topic';
    CREATE TABLE IF NOT EXISTS communication_messages (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,name TEXT NOT NULL,source_thread_id TEXT NOT NULL,target_thread_id TEXT,
      state TEXT NOT NULL,message TEXT NOT NULL,result TEXT,progress REAL,feedback_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deadline_at TEXT
    );
    CREATE INDEX IF NOT EXISTS communication_source ON communication_messages(user_id,source_thread_id,created_at);
    CREATE INDEX IF NOT EXISTS communication_target ON communication_messages(user_id,target_thread_id,created_at);
    CREATE TABLE IF NOT EXISTS communication_deliveries (
      message_id TEXT NOT NULL,thread_id TEXT NOT NULL,read_at TEXT,PRIMARY KEY(message_id,thread_id),
      FOREIGN KEY(message_id) REFERENCES communication_messages(id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES thread_owners(thread_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS communication_inbox ON communication_deliveries(thread_id,read_at,message_id);
    CREATE TABLE IF NOT EXISTS communication_receipts (
      user_id TEXT NOT NULL,thread_id TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,result_json TEXT NOT NULL,
      PRIMARY KEY(user_id,thread_id,request_id)
    );`);
  }
  private accessible(userId: string, threadId: string): boolean {
    return this.owners.userCanAccessThread(threadId, userId) && !this.owners.isThreadArchivedLocal(threadId, userId);
  }
  private assertAccess(userId: string, threadId: string) {
    if (!this.accessible(userId, threadId)) throw new CommunicationError("会话不存在、已归档或不属于当前用户。", 403);
  }
  private threadName(userId: string, threadId: string): string {
    const owner = this.owners.getThreadOwner(threadId);
    return owner?.userId === userId ? owner.displayName ?? threadId : "已不可访问的会话";
  }
  private present(userId: string, row: Row, inbox = false): CommunicationMessage {
    const { feedbackJson, readAt, ...value } = row;
    return { ...value, sourceThreadName: this.threadName(userId, row.sourceThreadId), targetThreadName: row.targetThreadId ? this.threadName(userId, row.targetThreadId) : null,
      feedback: JSON.parse(feedbackJson), unread: inbox && readAt == null };
  }
  private expire(userId: string): string[] {
    const now = new Date(this.clock()).toISOString();
    // An accepted Action may have side effects. Only its pre-acceptance wait
    // expires automatically; cancellation of running work needs provider ack.
    const rows = this.db.prepare(`SELECT id,source_thread_id AS source,target_thread_id AS target FROM communication_messages
      WHERE user_id=? AND state='pending' AND kind IN ('service','action') AND deadline_at<=?`).all(userId, now) as Array<{ id: string; source: string; target: string }>;
    for (const row of rows) this.db.prepare("UPDATE communication_messages SET state='timed_out',updated_at=? WHERE id=?").run(now, row.id);
    return rows.flatMap(row => [row.source, row.target]);
  }
  private notify(userId: string, threadIds: string[]) {
    if (threadIds.length) this.emit("change", { userId, threadIds: [...new Set(threadIds)] } satisfies CommunicationChange);
  }
  snapshot(userId: string, threadId: string, limit = 25): CommunicationSnapshot {
    this.assertAccess(userId, threadId);
    this.notify(userId, this.expire(userId));
    limit = Math.max(1, Math.min(25, Math.trunc(limit)));
    const bindings = this.db.prepare("SELECT kind,name,thread_id AS threadId FROM communication_bindings WHERE user_id=? ORDER BY kind,name,thread_id").all(userId) as Omit<CommunicationBinding, "threadName">[];
    const directory = bindings.filter(binding => this.accessible(userId, binding.threadId)).map(binding => ({ ...binding, threadName: this.threadName(userId, binding.threadId) }));
    const inbox = (this.db.prepare(`SELECT ${columns},d.read_at AS readAt FROM communication_messages m JOIN communication_deliveries d ON d.message_id=m.id
      WHERE m.user_id=? AND d.thread_id=? ORDER BY CASE WHEN m.kind!='topic' AND m.state IN ('pending','accepted','executing','cancel_requested') THEN 0 WHEN d.read_at IS NULL THEN 1 ELSE 2 END,m.updated_at DESC,m.id DESC LIMIT ?`).all(userId, threadId, limit) as Row[]).map(row => this.present(userId, row, true));
    const outbox = (this.db.prepare(`SELECT ${columns} FROM communication_messages m WHERE m.user_id=? AND m.source_thread_id=?
      ORDER BY CASE WHEN m.state IN ('pending','accepted','executing','cancel_requested') THEN 0 ELSE 1 END,m.updated_at DESC,m.id DESC LIMIT ?`).all(userId, threadId, limit) as Row[]).map(row => this.present(userId, row));
    const count = this.db.prepare(`SELECT count(*) AS count FROM communication_deliveries d JOIN communication_messages m ON m.id=d.message_id
      WHERE m.user_id=? AND d.thread_id=? AND d.read_at IS NULL`).get(userId, threadId) as { count: number };
    return { threadId, sampledAt: new Date(this.clock()).toISOString(), directory, bindings: directory.filter(binding => binding.threadId === threadId), inbox, outbox, unreadCount: count.count };
  }
  get(userId: string, threadId: string, messageId: string): CommunicationMessage {
    this.assertAccess(userId, threadId); this.notify(userId, this.expire(userId));
    const row = this.db.prepare(`SELECT ${columns},d.read_at AS readAt FROM communication_messages m LEFT JOIN communication_deliveries d ON d.message_id=m.id AND d.thread_id=?
      WHERE m.user_id=? AND m.id=? AND (m.source_thread_id=? OR d.thread_id=?)`).get(threadId, userId, messageId, threadId, threadId) as Row | undefined;
    if (!row) throw new CommunicationError("消息不存在或当前会话无权读取。", 404);
    return this.present(userId, row, row.sourceThreadId !== threadId);
  }
  execute(userId: string, threadId: string, input: unknown): Record<string, unknown> {
    this.assertAccess(userId, threadId);
    const command = communicationCommandSchema.parse(input) as CommunicationCommand;
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    let changed = [threadId];
    this.db.exec("BEGIN IMMEDIATE");
    let result: Record<string, unknown>;
    try {
      changed.push(...this.expire(userId));
      const receipt = this.db.prepare("SELECT digest,result_json FROM communication_receipts WHERE user_id=? AND thread_id=? AND request_id=?").get(userId, threadId, command.requestId) as { digest: string; result_json: string } | undefined;
      if (receipt) {
        if (receipt.digest !== digest) throw new CommunicationError("该请求编号已用于其他内容，请使用新的请求编号。");
        result = JSON.parse(receipt.result_json);
      } else {
        const now = new Date(this.clock()).toISOString();
        if (["topic.subscribe", "service.advertise", "action.advertise"].includes(command.operation) && "name" in command) {
          const kind = command.operation.split(".")[0] as CommunicationKind;
          const existing = this.db.prepare("SELECT thread_id AS threadId FROM communication_bindings WHERE user_id=? AND kind=? AND name=?").all(userId, kind, command.name) as Array<{ threadId: string }>;
          for (const binding of existing) if (!this.accessible(userId, binding.threadId)) this.db.prepare("DELETE FROM communication_bindings WHERE user_id=? AND kind=? AND name=? AND thread_id=?").run(userId, kind, command.name, binding.threadId);
          if (kind !== "topic" && existing.some(binding => binding.threadId !== threadId && this.accessible(userId, binding.threadId))) throw new CommunicationError("该服务或任务名称已有提供会话，请选择其他名称。");
          this.db.prepare("INSERT OR IGNORE INTO communication_bindings(user_id,kind,name,thread_id) VALUES(?,?,?,?)").run(userId, kind, command.name, threadId);
          result = { registered: true, name: command.name };
        } else if (["topic.unsubscribe", "service.unadvertise", "action.unadvertise"].includes(command.operation) && "name" in command) {
          this.db.prepare("DELETE FROM communication_bindings WHERE user_id=? AND kind=? AND name=? AND thread_id=?").run(userId, command.operation.split(".")[0], command.name, threadId);
          result = { registered: false };
        } else if (command.operation === "topic.publish" || command.operation === "service.call" || command.operation === "action.send") {
          const kind = command.operation.split(".")[0] as CommunicationKind;
          const bindings = this.db.prepare("SELECT thread_id AS threadId FROM communication_bindings WHERE user_id=? AND kind=? AND name=?").all(userId, kind, command.name) as Array<{ threadId: string }>;
          const recipients = bindings.filter(binding => this.accessible(userId, binding.threadId));
          if (kind !== "topic" && !recipients.length) throw new CommunicationError("该服务或任务当前没有可用的提供会话。", 404);
          if (kind !== "topic") {
            const count = this.db.prepare(`SELECT sum(CASE WHEN source_thread_id=? THEN 1 ELSE 0 END) AS outgoing,sum(CASE WHEN target_thread_id=? THEN 1 ELSE 0 END) AS incoming
              FROM communication_messages WHERE user_id=? AND state IN ('pending','accepted','executing','cancel_requested')`).get(threadId, recipients[0].threadId, userId) as { outgoing: number | null; incoming: number | null };
            if ((count.outgoing ?? 0) >= 25 || (count.incoming ?? 0) >= 25) throw new CommunicationError("会话已有 25 个未结束请求，请处理后重试。", 429);
          }
          const messageId = randomUUID(), state = kind === "topic" ? "published" : "pending";
          const deadline = kind === "topic" ? null : new Date(this.clock() + ("timeoutSeconds" in command ? command.timeoutSeconds! : 120) * 1000).toISOString();
          this.db.prepare(`INSERT INTO communication_messages(id,user_id,kind,name,source_thread_id,target_thread_id,state,message,created_at,updated_at,deadline_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, userId, kind, command.name, threadId, kind === "topic" ? null : recipients[0].threadId, state, command.message, now, now, deadline);
          for (const recipient of recipients) this.db.prepare("INSERT INTO communication_deliveries(message_id,thread_id) VALUES(?,?)").run(messageId, recipient.threadId);
          changed.push(...recipients.map(recipient => recipient.threadId));
          result = { id: messageId, state, delivered: recipients.length };
        } else if ("id" in command) {
          const row = this.db.prepare(`SELECT ${columns} FROM communication_messages m WHERE m.id=? AND m.user_id=?`).get(command.id, userId) as Row | undefined;
          if (!row) throw new CommunicationError("消息不存在或不可访问。", 404);
          changed.push(row.sourceThreadId, ...(row.targetThreadId ? [row.targetThreadId] : []));
          if (command.operation === "inbox.ack") {
            const delivery = this.db.prepare("SELECT thread_id FROM communication_deliveries WHERE message_id=? AND thread_id=?").get(row.id, threadId);
            if (!delivery) throw new CommunicationError("只有接收会话可以确认收件。", 403);
            this.db.prepare("UPDATE communication_deliveries SET read_at=COALESCE(read_at,?) WHERE message_id=? AND thread_id=?").run(now, row.id, threadId);
            result = { id: row.id, acknowledged: true };
          } else {
            if (terminal.has(row.state)) throw new CommunicationError("该请求已经结束，不能再次修改。");
            let next: CommunicationState = row.state, response = row.result, progress = row.progress;
            const feedback: CommunicationMessage["feedback"] = JSON.parse(row.feedbackJson);
            if (command.operation === "service.respond") {
              if (row.kind !== "service" || row.targetThreadId !== threadId) throw new CommunicationError("只有该服务的提供会话可以回复。", 403);
              next = command.success ? "succeeded" : "failed"; response = command.result;
            } else if (command.operation === "action.cancel") {
              if (row.kind !== "action" || row.sourceThreadId !== threadId) throw new CommunicationError("只有任务发起会话可以请求取消。", 403);
              next = row.state === "pending" ? "canceled" : "cancel_requested";
            } else if (command.operation === "action.update") {
              if (row.kind !== "action" || row.targetThreadId !== threadId) throw new CommunicationError("只有任务提供会话可以更新进度和结果。", 403);
              if (row.state === "pending" && !["accepted", "rejected"].includes(command.status)) throw new CommunicationError("请先接收或拒绝任务，再反馈执行状态。");
              if (row.state !== "pending" && command.status === "rejected") throw new CommunicationError("任务已被接收，请返回失败原因或确认取消。");
              if (row.state !== "pending" && command.status === "accepted") throw new CommunicationError("该任务已接收，不能重复接收。");
              if (command.status === "canceled" && row.state !== "cancel_requested") throw new CommunicationError("尚未收到取消请求；提供会话可使用失败状态终止任务。");
              if (["succeeded", "failed", "rejected", "canceled"].includes(command.status) && !command.message?.trim()) throw new CommunicationError("结束任务时请填写结果或原因。", 400);
              next = row.state === "cancel_requested" && command.status === "executing" ? row.state : command.status;
              progress = command.status === "succeeded" ? 100 : command.progress ?? progress;
              if (terminal.has(next)) response = command.message ?? null;
              if (command.message || command.progress !== undefined) feedback.push({ at: now, message: command.message ?? "", progress });
            } else throw new CommunicationError("该操作不适用于此消息。", 400);
            this.db.prepare("UPDATE communication_messages SET state=?,result=?,progress=?,feedback_json=?,updated_at=? WHERE id=?").run(next, response, progress, JSON.stringify(feedback.slice(-50)), now, row.id);
            if (row.targetThreadId === threadId) this.db.prepare("UPDATE communication_deliveries SET read_at=COALESCE(read_at,?) WHERE message_id=? AND thread_id=?").run(now, row.id, threadId);
            result = { id: row.id, state: next };
          }
        } else throw new CommunicationError("不支持的通信操作。", 400);
        this.db.prepare("INSERT INTO communication_receipts(user_id,thread_id,request_id,digest,result_json) VALUES(?,?,?,?,?)").run(userId, threadId, command.requestId, digest, JSON.stringify(result));
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.notify(userId, changed);
    return result;
  }
}
