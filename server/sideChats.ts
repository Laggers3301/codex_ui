import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import type { ProjectStore } from "./db.js";
import type { CodexBridge } from "./codexBridge.js";
import type { SideChat, SideChatChange } from "../shared/sideChat.js";

export class SideChatError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

const columns = `id, user_id AS userId, project_id AS projectId, parent_thread_id AS parentThreadId,
  thread_id AS threadId, selected_text AS selectedText, draft, model_profile_id AS modelProfileId,
  request_id AS requestId, last_prompt AS lastPrompt, turn_id AS turnId, status, error, revision,
  created_at AS createdAt, updated_at AS updatedAt`;

export class SideChatStore {
  private readonly events = new EventEmitter();
  constructor(private db: DatabaseSync, private owners: ProjectStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS side_chats (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL, thread_id TEXT,
      selected_text TEXT NOT NULL, draft TEXT NOT NULL DEFAULT '', model_profile_id TEXT NOT NULL,
      request_id TEXT, last_prompt TEXT NOT NULL DEFAULT '', turn_id TEXT,
      status TEXT NOT NULL DEFAULT 'ready', error TEXT, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      UNIQUE(user_id, parent_thread_id), UNIQUE(thread_id),
      FOREIGN KEY(parent_thread_id) REFERENCES thread_owners(thread_id) ON DELETE CASCADE,
      FOREIGN KEY(thread_id) REFERENCES thread_owners(thread_id) ON DELETE CASCADE,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_side_chats_user_project ON side_chats(user_id, project_id);`);
  }

  subscribe(listener: (change: SideChatChange) => void): () => void {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  get(parentThreadId: string, userId: string, projectId: string): SideChat | null {
    if (!this.owners.userCanAccessThread(parentThreadId, userId, projectId)) return null;
    return this.db.prepare(`SELECT ${columns} FROM side_chats WHERE parent_thread_id=? AND user_id=? AND project_id=? AND deleted_at IS NULL`)
      .get(parentThreadId, userId, projectId) as unknown as SideChat ?? null;
  }

  byId(id: string, userId: string): SideChat | null {
    return this.db.prepare(`SELECT ${columns} FROM side_chats WHERE id=? AND user_id=? AND deleted_at IS NULL`)
      .get(id, userId) as unknown as SideChat ?? null;
  }

  forThread(threadId: string): SideChat | null {
    return this.db.prepare(`SELECT ${columns} FROM side_chats WHERE thread_id=? AND deleted_at IS NULL`)
      .get(threadId) as unknown as SideChat ?? null;
  }

  threadIds(userId: string, projectId?: string): Set<string> {
    const sql = "SELECT thread_id FROM side_chats WHERE user_id=? AND thread_id IS NOT NULL" + (projectId ? " AND project_id=?" : "");
    return new Set((this.db.prepare(sql).all(...(projectId ? [userId, projectId] : [userId])) as Array<{ thread_id: string }>).map(row => row.thread_id));
  }

  private changed(side: SideChat, deleted = false): void {
    this.events.emit("change", { id: side.id, userId: side.userId, projectId: side.projectId,
      parentThreadId: side.parentThreadId, sideChat: deleted ? null : this.byId(side.id, side.userId) } satisfies SideChatChange);
  }

  create(parentThreadId: string, userId: string, projectId: string, selectedText: string, modelProfileId: string): SideChat {
    if (!this.owners.userCanAccessThread(parentThreadId, userId, projectId) || this.forThread(parentThreadId)) {
      throw new SideChatError("主会话不可访问，无法建立侧边会话。", 403);
    }
    const existing = this.get(parentThreadId, userId, projectId);
    if (existing) return existing;
    const now = new Date().toISOString(), id = randomUUID();
    this.db.prepare(`INSERT INTO side_chats(id,user_id,project_id,parent_thread_id,selected_text,model_profile_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,parent_thread_id) DO UPDATE SET
      id=excluded.id,thread_id=NULL,selected_text=excluded.selected_text,model_profile_id=excluded.model_profile_id,
      draft='',request_id=NULL,last_prompt='',turn_id=NULL,status='ready',error=NULL,revision=1,
      created_at=excluded.created_at,updated_at=excluded.updated_at,deleted_at=NULL WHERE side_chats.deleted_at IS NOT NULL`)
      .run(id, userId, projectId, parentThreadId, selectedText, modelProfileId, now, now);
    const side = this.get(parentThreadId, userId, projectId)!;
    this.changed(side);
    return side;
  }

  saveDraft(id: string, userId: string, draft: string, modelProfileId: string, expectedRequestId: string | null): SideChat {
    const side = this.byId(id, userId);
    if (!side) throw new SideChatError("侧边会话已关闭。", 404);
    if (side.requestId !== expectedRequestId || side.status === "closing") throw new SideChatError("侧边会话已更新，请重试。");
    const result = this.db.prepare("UPDATE side_chats SET draft=?,model_profile_id=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND request_id IS ? AND status<>'closing'")
      .run(draft, modelProfileId, new Date().toISOString(), id, expectedRequestId);
    if (!result.changes) throw new SideChatError("侧边会话已更新，请重试。");
    this.changed(side);
    return this.byId(id, userId)!;
  }

  begin(id: string, userId: string, projectId: string, requestId: string, prompt: string, threadId: string | null, modelProfileId?: string): SideChat {
    const side = this.byId(id, userId);
    if (!side || side.projectId !== projectId || side.threadId !== threadId
      || !this.owners.userCanAccessThread(side.parentThreadId, userId, projectId)
      || (threadId && !this.owners.userCanAccessThread(threadId, userId, projectId))) {
      throw new SideChatError("侧边会话不可访问。", 403);
    }
    if (["starting", "running", "closing"].includes(side.status)) throw new SideChatError("侧边会话正在处理上一条请求，请稍后再发送。");
    const result = this.db.prepare(`UPDATE side_chats SET request_id=?,last_prompt=?,draft='',turn_id=NULL,status='starting',error=NULL,
      model_profile_id=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND revision=?`)
      .run(requestId, prompt, modelProfileId?.slice(0, 200) || side.modelProfileId, new Date().toISOString(), id, side.revision);
    if (!result.changes) throw new SideChatError("侧边会话已更新，请重试。");
    this.changed(side);
    return this.byId(id, userId)!;
  }

  attach(id: string, userId: string, requestId: string, threadId: string): boolean {
    const side = this.byId(id, userId);
    if (!side || side.requestId !== requestId || side.status === "closing") return false;
    if (!this.owners.userCanAccessThread(threadId, userId, side.projectId) || threadId === side.parentThreadId) {
      throw new SideChatError("侧边会话归属不匹配。", 403);
    }
    const result = this.db.prepare("UPDATE side_chats SET thread_id=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND request_id=? AND status<>'closing'")
      .run(threadId, new Date().toISOString(), id, requestId);
    if (!result.changes) return false;
    this.changed(side);
    return true;
  }

  accepted(id: string, userId: string, requestId: string, turnId: string | null): boolean {
    const side = this.byId(id, userId);
    if (!side || side.status === "closing" || side.requestId !== requestId) return false;
    const result = this.db.prepare(`UPDATE side_chats SET status=CASE WHEN turn_id IS ? AND status IN ('complete','error') THEN status ELSE 'running' END,
      turn_id=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND request_id=? AND status<>'closing'`)
      .run(turnId, turnId, new Date().toISOString(), id, requestId);
    if (!result.changes) return false;
    this.changed(side);
    return true;
  }

  failed(id: string, userId: string, requestId: string, error: unknown): void {
    const side = this.byId(id, userId);
    if (!side || side.requestId !== requestId || side.status !== "starting") return;
    this.db.prepare("UPDATE side_chats SET status='error',error=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND status='starting' AND request_id=?")
      .run(error instanceof Error ? error.message : String(error), new Date().toISOString(), id, requestId);
    this.changed(side);
  }

  turn(threadId: string, turnId: string, completed: boolean, error?: string): void {
    const side = this.forThread(threadId);
    if (!side || side.status === "closing" || (side.turnId && side.turnId !== turnId && side.status !== "starting")) return;
    if (completed && side.turnId !== turnId) return;
    this.db.prepare("UPDATE side_chats SET turn_id=?,status=?,error=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND revision=?")
      .run(turnId, completed ? (error ? "error" : "complete") : "running", error ?? null, new Date().toISOString(), side.id, side.revision);
    this.changed(side);
  }

  closing(side: SideChat): void {
    if (this.byId(side.id, side.userId)?.status === "closing") throw new SideChatError("侧边会话正在关闭。");
    const result = this.db.prepare("UPDATE side_chats SET status='closing',revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND revision=?")
      .run(new Date().toISOString(), side.id, side.revision);
    if (!result.changes) throw new SideChatError("侧边会话状态已更新，请重试关闭。");
    this.changed(side);
  }

  restoreAfterCloseFailure(side: SideChat): void {
    this.db.prepare("UPDATE side_chats SET status=?,turn_id=?,error=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL AND status='closing'")
      .run(side.status, side.turnId, side.error, new Date().toISOString(), side.id);
    this.changed(side);
  }

  forget(side: SideChat): void {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE side_chats SET deleted_at=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL")
      .run(now, now, side.id);
    if (result.changes) this.changed(side, true);
  }

  forgetForThread(threadId: string): void {
    const rows = this.db.prepare(`SELECT ${columns} FROM side_chats WHERE (thread_id=? OR parent_thread_id=?) AND deleted_at IS NULL`)
      .all(threadId, threadId) as unknown as SideChat[];
    for (const side of rows) this.forget(side);
  }
}

export async function closeSideChat(bridge: CodexBridge, store: ProjectStore, side: SideChat): Promise<void> {
  store.sideChats.closing(side);
  try {
    const recovery = side.threadId ? store.getTurnRecoveryState(side.threadId) : null;
    // The native start operation (or its turn/started notification) completes
    // cancellation once its thread/turn ids are known. Keep an accessible
    // closing record instead of forgetting an in-flight model request.
    if (side.status === "starting" && recovery?.job?.status !== "waiting") return;
    if (side.status === "running") {
      if (!side.turnId) throw new SideChatError("任务状态尚未确认，请稍后再关闭。");
      await interruptSideTurn(bridge, side.threadId!, side.turnId);
    }
    if (side.threadId) {
      const recovery = store.getTurnRecoveryState(side.threadId);
      if (recovery) store.setTurnRecoveryState({ ...recovery, job: null, cancelled: true });
      store.softDeleteThread(side.threadId, side.userId, side.projectId);
    }
    store.sideChats.forget(side);
  } catch (error) {
    store.sideChats.restoreAfterCloseFailure({ ...side, error: `关闭侧边会话失败：${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}

async function interruptSideTurn(bridge: CodexBridge, threadId: string, turnId: string): Promise<void> {
  try { await bridge.request("turn/interrupt", { threadId, turnId }, 10_000); }
  catch (error) {
    if (!/no active turn|not active|not running|already completed|turn.*not found/i.test(String(error))) throw error;
  }
}

export async function settleClosedSideChat(bridge: CodexBridge, store: ProjectStore, id: string, userId: string, threadId: string, turnId: string | null): Promise<void> {
  const side = store.sideChats.byId(id, userId);
  try {
    if (turnId) await interruptSideTurn(bridge, threadId, turnId);
    const recovery = store.getTurnRecoveryState(threadId);
    if (recovery) store.setTurnRecoveryState({ ...recovery, job: null, cancelled: true });
    store.softDeleteThread(threadId, userId, store.getThreadOwner(threadId)!.projectId);
    if (side) store.sideChats.forget(side);
  } catch (error) {
    if (side) store.sideChats.restoreAfterCloseFailure({ ...side, threadId, turnId, status: "running", error: `停止侧边任务失败：${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}
