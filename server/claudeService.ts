import { MAX_FULL_HISTORY_BYTES } from "./rolloutStorage.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexBridge } from "./codexBridge.js";
import type { ProjectStore } from "./db.js";
import type { RpcEnvelope } from "./types.js";
import { AppError } from "./appErrors.js";
import { isReclaudeModel } from "../shared/agentRuntime.js";
import { assertCodexModelRequest } from "./agentRuntimeGuard.js";
import { ClaudeBindings, type ClaudeBinding, type ClaudeIntegrationConfig } from "./claudeBindings.js";
import { ClaudeRuntime } from "./claudeRuntime.js";
import { assertClaudeExecutionAllowed } from "./claudeExecutionPolicy.js";
import { ClaudeSessionStorage, claudeConfigRoots, locateClaudeHistory, stageClaudeHistory, hashClaudeHistory, type ClaudeConversation } from "./claudeSessionStorage.js";
import { ReclaudeUsageMonitor } from "./reclaudeUsage.js";
import type { ReclaudeUsageStatus } from "../shared/reclaudeUsage.js";
import { ReclaudeLifecycle } from "./reclaudeLifecycle.js";
import { ReclaudeAuthorization } from "./reclaudeAuthorization.js";

type RecordValue = Record<string, any>;
const object = (v: unknown): RecordValue => v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const run = promisify(execFile);
const services = new WeakMap<object, ClaudeService>();
const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

export function getClaudeService(bridge: object): ClaudeService | undefined { return services.get(bridge); }
export function assertRuntimeModel(bridge: object, userId: string, params: unknown, threadId?: string) {
  const p = object(params), model = p.model ?? p.defaultModel ?? p.collaborationMode?.settings?.model;
  const service = services.get(bridge);
  if (threadId && !!service?.owns(threadId) !== isReclaudeModel(model)) {
    throw new AppError("runtime_mismatch", "此会话的运行引擎不可直接更换，请为另一引擎新建会话。");
  }
  if (isReclaudeModel(model) && service) service.bindings.resolve(userId, model);
  else assertCodexModelRequest(params);
}

export class ClaudeService {
  private closed = false;
  readonly bindings: ClaudeBindings;
  readonly storage: ClaudeSessionStorage;
  readonly usage: ReclaudeUsageMonitor;
  readonly lifecycle: ReclaudeLifecycle;
  readonly authorization: ReclaudeAuthorization;
  private usageTimer?: ReturnType<typeof setInterval>;
  private busy = new Set<string>();
  private active = new Map<string, ClaudeRuntime>();
  private runtimeLeases = new Map<string, () => void>();
  private approvals = new Map<string, { id: string; method: string; params: unknown; receivedAt: string; runtime: ClaudeRuntime; userId: string }>();

  constructor(readonly config: ClaudeIntegrationConfig, readonly store: ProjectStore,
    private emit: (type: string, event: RpcEnvelope) => void,
    private runtimeFactory = (binding: ClaudeBinding) => new ClaudeRuntime(binding),
    private forkWorker = offlineFork) {
    this.bindings = new ClaudeBindings(config);
    this.storage = new ClaudeSessionStorage(config.storageDirectory);
    this.lifecycle = new ReclaudeLifecycle(config.home);
    this.recoverBindingMigrations();
    this.authorization = new ReclaudeAuthorization(config, this.bindings, this.lifecycle, orgId => this.snapshotHistory(orgId));
    this.usage = new ReclaudeUsageMonitor(this.storage.db, (accountKey, error) => {
      for (const [id, runtime] of this.active) {
        const row = this.storage.get(id);
        if (row?.accountKey === accountKey) runtime.interrupt(row.userId, id, error);
      }
    });
    if (config.usageCacheFile) {
      this.refreshUsageCache();
      this.usageTimer = setInterval(() => this.refreshUsageCache(), 60_000);
      this.usageTimer.unref();
    }
    // A backend restart never repeats an uncertain model invocation.
    this.storage.interruptUnfinishedTurns();
  }
  owns(id: string): boolean { return !!this.storage.get(id); }
  private refreshUsageCache() {
    if (!this.config.usageCacheFile) return;
    const users = this.config.sharedUsers
      ? this.store.listUsers().map(user => user.id)
      : Object.keys(this.config.users ?? {});
    this.usage.readCache(this.config.usageCacheFile,
      users.flatMap(user => this.bindings.list(user)));
  }
  usageStatus(userId: string): ReclaudeUsageStatus {
    return { thresholdPercent: 99, accounts: this.bindings.list(userId).map(binding => this.usage.status(binding)),
      creations: this.storage.quota(), monitoring: this.config.usageCacheFile ? "response-events-and-cache" : "response-events",
      ...(this.usage.cacheError ? {cacheError:this.usage.cacheError} : {}) };
  }
  profiles(userId: string) {
    const bindings=new Map(this.bindings.list(userId).map(b=>[b.orgId,b]));
    return this.bindings.profiles(userId).map(profile => {
      const status = this.usage.status(bindings.get(profile.model.split("@")[1])!);
      return status.state === "disabled" ? {...profile, availability:"disabled" as const, unavailableReason:status.message} : profile;
    });
  }
  private row(id: string): ClaudeConversation {
    const row = this.storage.get(id);
    if (!row) throw new AppError("thread_not_found", "Claude 会话不存在。");
    const owner = this.store.getThreadOwner(id);
    if (!owner || owner.userId !== row.userId || owner.projectId !== row.projectId || path.resolve(owner.rootPath) !== path.resolve(row.cwd)) {
      throw new AppError("runtime_forbidden", "Claude 会话的用户、项目或工作目录归属不一致，未修改会话记录。");
    }
    return row;
  }
  private recoverBindingMigrations(threadId?: string) {
    for (const migration of this.storage.pendingBindingMigrations()) {
      if (threadId && migration.after.id !== threadId) continue;
      try {
        const owner = this.store.getThreadOwner(migration.after.id), next = migration.after;
        if (!owner || owner.userId !== next.userId || owner.projectId !== next.projectId || path.resolve(owner.rootPath) !== path.resolve(next.cwd)) throw new Error("ownership_changed");
        if (owner.modelOverride !== next.model && !this.store.setThreadModelConfig(next.id, next.userId, next.model, owner.reasoningEffortOverride ?? "medium")) throw new Error("owner_update_failed");
        this.storage.finishBindingMigration(migration);
      } catch {
        if (threadId) throw new AppError("claude_migration_pending", "上次会话迁移的数据库映射尚未完成，请稍后重试；原历史仍保留。");
      }
    }
  }
  private snapshotHistory(orgId: string) {
    for (const item of this.storage.list().filter(row => row.orgId === orgId && row.initialized && !row.archived)) {
      this.recoverBindingMigrations(item.id);
      const row = this.row(item.id), source = this.source(row);
      const target = path.join(this.config.storageDirectory, "reauth-history", row.nativeSessionId, hashClaudeHistory(source));
      stageClaudeHistory(source, target, row.nativeSessionId, path.join(this.config.storageDirectory, "archive"));
      this.rememberArchive(row, source); this.storage.save(row);
    }
  }
  private finishRuntime(threadId: string) {
    this.active.delete(threadId);
    this.runtimeLeases.get(threadId)?.(); this.runtimeLeases.delete(threadId);
  }
  private idle(id: string) { if (this.busy.has(id) || this.active.has(id)) throw new AppError("turn_in_progress", "该 Claude 会话正在运行，请结束本轮后切换或 fork。"); }
  private async locked<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.idle(id); this.busy.add(id);
    try { return await work(); } finally { this.busy.delete(id); }
  }
  private assertCwd(binding: ClaudeBinding, cwd: string) {
    const relative = path.relative(fs.realpathSync(binding.workspaceRoot), fs.realpathSync(cwd));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AppError("workspace_forbidden", "Claude 工作目录不属于当前用户。");
  }
  summary(row: ClaudeConversation): RecordValue {
    return { id: row.id, name: row.name, preview: row.name, cwd: row.cwd, model: row.model, modelProvider: "reclaude",
      runtime: "claude-code", configuredModel: row.model, configuredReasoningEffort: this.store.getThreadOwner(row.id)?.reasoningEffortOverride??"medium",
      collaborationMode: row.collaborationMode ?? "default",
      createdAt: Math.floor(row.createdAt / 1000), updatedAt: Math.floor(row.updatedAt / 1000),
      status: { type: this.active.has(row.id) ? "active" : "idle" }, turns: [], archived: row.archived };
  }
  list(userId: string, projectId: string) { return this.storage.list(userId, projectId).map(row => this.summary(row)); }
  private count(row: ClaudeConversation) { return (row.inheritedTurnCount ?? 0) + this.storage.turnCount(row.id); }
  private turns(row: ClaudeConversation, limit: number, before = 0, maxBytes = MAX_FULL_HISTORY_BYTES): RecordValue[] {
    const ownCount = this.storage.turnCount(row.id);
    const ownLimit = before < ownCount ? Math.min(limit, ownCount - before) : 0;
    const own = ownLimit ? this.storage.turns(row.id, ownLimit, before, maxBytes) : [];
    const inherited = row.parentThreadId && row.inheritedTurnCount ? this.storage.get(row.parentThreadId) : null;
    // A byte-limited own page must not jump over its remaining turns to the parent.
    if (!inherited || own.length >= limit || own.length < ownLimit) return own;
    const skipped = Math.max(0, before - ownCount);
    const remaining = Math.max(0, (row.inheritedTurnCount ?? 0) - skipped);
    const remainingBytes = maxBytes - own.reduce((sum, turn) => sum + Buffer.byteLength(JSON.stringify(turn)), 0);
    return [...(remaining && remainingBytes > 0 ? this.turns(inherited, Math.min(limit - own.length, remaining), this.count(inherited) - (row.inheritedTurnCount ?? 0) + skipped, remainingBytes) : []), ...own];
  }
  history(id: string, before = 0, limit = 50) {
    const row = this.row(id), total = this.count(row);
    const turns = this.turns(row, Math.min(100, limit), before);
    return { thread: { ...this.summary(row), turns }, history: { totalItems: total, returnedItems: turns.length,
      before, nextBefore: before + turns.length, hasOlder: before + turns.length < total } };
  }
  private source(row: ClaudeConversation): string {
    const file = locateClaudeHistory(row.nativeSessionId, claudeConfigRoots(this.config.home), row.configRoot);
    if (file) return file;
    if (row.historyArchive && fs.existsSync(row.historyArchive)) return row.historyArchive;
    throw new AppError("claude_history_missing", "完整原生历史尚未找到，已停止切换；不会用空白会话或摘要代替。");
  }
  withHistorySnapshot<T>(id: string, work: (file: string, row: ClaudeConversation) => Promise<T>): Promise<T> {
    return this.locked(id, () => { const row=this.row(id);return work(this.source(row),row); });
  }
  private rememberArchive(row: ClaudeConversation, source: string) {
    row.historyArchive = path.join(this.config.storageDirectory, "archive", row.nativeSessionId, hashClaudeHistory(source), `${row.nativeSessionId}.jsonl`);
  }
  private async branchNative(row: ClaudeConversation, binding: ClaudeBinding, cwd: string, title: string, cutoff?: string) {
    const source = this.source(row);
    // Reserve before any offline mutation. One global ledger, even across users,
    // processes and restarts. Failed/uncertain attempts retain their slot.
    this.storage.reserve(randomUUID());
    const staging = path.join(this.config.storageDirectory, "fork-staging", randomUUID());
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    // Never place the source id in the target account. An isolated staging root
    // makes it impossible for fork to accidentally resume the source remotely.
    stageClaudeHistory(source, staging, row.nativeSessionId, path.join(this.config.storageDirectory, "archive"));
    const nativeId = await this.forkWorker(row.nativeSessionId, staging, title, cutoff);
    const forked = locateClaudeHistory(nativeId, [staging]);
    if (!forked) throw new Error("离线 fork 未产生可验证的历史文件。");
    stageClaudeHistory(forked, binding.configRoot, nativeId, path.join(this.config.storageDirectory, "archive"));
    this.assertCwd(binding, cwd);
    return nativeId;
  }
  private async prepare(row: ClaudeConversation, model: string): Promise<ClaudeBinding> {
    this.refreshUsageCache();
    this.usage.assertAvailable(this.bindings.resolve(row.userId, model));
    const binding = await this.bindings.refresh(row.userId, model);
    this.usage.assertAvailable(binding);
    this.assertCwd(binding, row.cwd);
    const before = { ...row }, next = { ...row };
    if (row.initialized) {
      if (row.accountKey !== binding.accountKey || row.orgId !== binding.orgId) {
        const previous = row.nativeSessionId;
        next.nativeSessionId = await this.branchNative(row, binding, row.cwd, row.name);
        next.parentSessionId = previous;
        const target = locateClaudeHistory(next.nativeSessionId, [binding.configRoot]);
        if (target) this.rememberArchive(next, target);
      } else if (row.configRoot !== binding.configRoot || !locateClaudeHistory(row.nativeSessionId, [binding.configRoot])) {
        const target = stageClaudeHistory(this.source(row), binding.configRoot, row.nativeSessionId, path.join(this.config.storageDirectory, "archive"));
        this.rememberArchive(next, target);
      }
    }
    Object.assign(next, { model, orgId: binding.orgId, accountKey: binding.accountKey, configRoot: binding.configRoot });
    this.storage.beginBindingMigration(before, next);
    this.recoverBindingMigrations(row.id);
    Object.assign(row, next);
    if (before.nativeSessionId !== next.nativeSessionId) this.emit("notification", { method: "runtime/accountSwitched", params: { threadId: row.id, mode: "offline-fork", orgId: binding.orgId } });
    return binding;
  }
  async request(method: string, p: RecordValue = {}): Promise<unknown> {
    if (this.closed) throw new AppError("runtime_not_connected", "Claude 运行时已关闭。");
    const readOnly = ["thread/read", "thread/turns/list", "thread/queue/list", "turn/interrupt"].includes(method)
      || (method === "thread/resume" && (!p.model || p.model === this.storage.get(String(p.threadId))?.model));
    const release = readOnly ? () => {} : this.lifecycle.acquireRun();
    try { this.recoverBindingMigrations(String(p.threadId ?? "")); return await this.dispatch(method, p); }
    finally { release(); }
  }
  private async dispatch(method: string, p: RecordValue): Promise<unknown> {
    if (method === "thread/start") {
      const userId = String(p.userId ?? ""), project = this.store.getProject(String(p.projectId ?? ""), userId);
      if (!project || project.rootPath !== p.cwd) throw new AppError("runtime_forbidden", "Claude 项目归属无法确认。");
      this.refreshUsageCache(); this.usage.assertAvailable(this.bindings.resolve(userId, p.model));
      const binding = await this.bindings.refresh(userId, p.model); this.assertCwd(binding, project.rootPath);
      this.usage.assertAvailable(binding);
      const row: ClaudeConversation = { id: randomUUID(), nativeSessionId: randomUUID(), userId, projectId: project.id, cwd: project.rootPath,
        name: "新 Claude 会话", model: p.model, orgId: binding.orgId, accountKey: binding.accountKey, configRoot: binding.configRoot,
        initialized: false, archived: false, createdAt: Date.now(), updatedAt: Date.now() };
      this.storage.reserve(row.nativeSessionId);
      this.storage.save(row);
      this.store.registerThreadOwner({ threadId: row.id, userId, projectId: row.projectId, rootPath: row.cwd, model: row.model, reasoningEffort: "medium" });
      return { thread: this.summary(row) };
    }
    const row = this.row(String(p.threadId ?? ""));
    if (method === "thread/turns/list") {
      if (p.cursor && !/^claude-turns:\d+$/.test(String(p.cursor))) throw new AppError("invalid_cursor", "历史分页位置无效，请重新打开会话。");
      const before = p.cursor ? Number(String(p.cursor).split(":")[1]) : 0;
      const turns = this.turns(row, Math.min(100, Math.max(1, Number(p.limit) || 50)), before);
      const next = before + turns.length;
      return {data: turns.reverse().map(turn=>({...turn,...(p.itemsView==="notLoaded"?{items:[]}:{})})),
        nextCursor: next < this.count(row) ? `claude-turns:${next}` : null};
    }
    if (method === "thread/read") return { thread: { ...this.summary(row), turns: p.includeTurns === false ? [] : this.turns(row, 50) } };
    if (method === "thread/resume") return this.locked(row.id, async () => {
      // Opening a conversation is read-only. Re-login migrations are lazy and
      // run when new input is actually sent, not when the sidebar is opened.
      if (p.model && p.model !== row.model) await this.prepare(row, p.model);
      return { thread: { ...this.summary(row), turns: p.excludeTurns ? [] : this.turns(row, 50) } };
    });
    if (method === "thread/fork") return this.locked(row.id, async () => {
      // Explicit fork is entirely local, including binding lookup. The next
      // user turn refreshes actual account identity before any model request.
      const model = p.model ?? row.model, binding = this.bindings.resolve(row.userId, model);
      const forkEffort=this.bindings.effort(row.userId,model,p.effort);
      this.refreshUsageCache(); this.usage.assertAvailable(binding);
      const project = this.store.getProject(p.projectId ?? row.projectId, row.userId);
      if (!project) throw new Error("目标项目不存在。");
      this.assertCwd(binding, project.rootPath);
      let cutoff: string | undefined, inheritedTurnCount = this.count(row);
      if (p.lastTurnId) {
        // Locate the requested UI turn in the inherited chain without loading
        // the entire native JSONL into the web process.
        let found = false;
        for (let before = 0; before < this.count(row);) {
          const turns = this.turns(row, 100, before), index = turns.findIndex(turn => turn.id === p.lastTurnId);
          if (index >= 0) { cutoff = turns[index].nativeMessageId; inheritedTurnCount = this.count(row) - before - turns.length + index + 1; found = true; break; }
          if (!turns.length) break;
          before += turns.length;
        }
        if (!found || !cutoff) throw new Error("所选轮次尚无原生分支位置，不能悄悄改为其他分支点。");
        // A preceding automatic fork remaps message UUIDs. Only the complete
        // current head is safe until its new UUID has been observed.
        const selected = this.storage.turn(String(p.lastTurnId));
        if (selected?.nativeSessionId !== row.nativeSessionId) {
          if (inheritedTurnCount === this.count(row)) cutoff = undefined;
          else throw new Error("该历史轮次来自更早的原生分支；请从当前最后一轮创建完整分支。");
        }
      }
      const nativeSessionId = await this.branchNative(row, binding, project.rootPath, `${row.name} · 分支`, cutoff);
      const child: ClaudeConversation = { ...row, id: randomUUID(), nativeSessionId, parentSessionId: row.nativeSessionId,
        parentThreadId: row.id, inheritedTurnCount, initialized: true, model, orgId: binding.orgId, accountKey: binding.accountKey,
        configRoot: binding.configRoot, projectId: project.id, cwd: project.rootPath, name: `${row.name} · 分支`, createdAt: Date.now(), updatedAt: Date.now() };
      const target = locateClaudeHistory(nativeSessionId, [binding.configRoot]);
      if (target) this.rememberArchive(child, target);
      this.storage.save(child);
      this.store.registerThreadOwner({ threadId: child.id, userId: child.userId, projectId: child.projectId, rootPath: child.cwd, model, reasoningEffort: forkEffort??"medium" });
      return { thread: this.summary(child) };
    });
    if (method === "turn/start") return this.locked(row.id, async () => {
      const parts: RecordValue[] = Array.isArray(p.input) ? p.input : [];
      if (parts.some(part => !["text", "skill"].includes(part.type))) throw new Error("当前 Claude 接入支持文字和技能引用，请将附件路径写入任务。");
      const prompt = parts.filter(part => part.type === "text").map(part => part.text).join("\n");
      assertClaudeExecutionAllowed({ prompt, skillNames: parts.filter(part => part.type === "skill").map(part => part.name), executionOrigin: p.executionOrigin });
      if (!prompt.trim()) throw new Error("Prompt is required.");
      const binding = await this.prepare(row, p.model ?? row.model);
      const effort=this.bindings.effort(row.userId,row.model,p.effort??this.store.getThreadOwner(row.id)?.reasoningEffortOverride);
      this.store.setThreadModelConfig(row.id,row.userId,row.model,effort??"medium");
      const mode=p.collaborationMode?.mode;
      if(mode!==undefined&&mode!=="plan"&&mode!=="default")throw new Error("Invalid collaboration mode.");
      row.collaborationMode=mode??row.collaborationMode??"default";
      const runtime = this.runtimeFactory(binding), turnId = randomUUID();
      const userItem = { id: `claude-user:${turnId}`, type: "userMessage", content: parts };
      let checkpoint: string | undefined;
      const turn: RecordValue = { id: turnId, status: "inProgress", items: [userItem], nativeSessionId: row.nativeSessionId };
      row.historyArchive = undefined; this.storage.save(row);
      const releaseRuntime = this.lifecycle.acquireRun();
      try { this.storage.saveTurn(row.id, turn); }
      catch (error) { releaseRuntime(); throw error; }
      this.runtimeLeases.set(row.id, releaseRuntime); this.active.set(row.id, runtime);
      runtime.on("nativeCheckpoint", event => { if (!this.closed) checkpoint = event.messageId; });
      runtime.on("rateLimit", event => {
        if (this.closed) return;
        this.usage.observeResponse(binding.accountKey, event);
        this.emit("notification", { method: "runtime/reclaudeUsage", params: { threadId: row.id, usage: this.usageStatus(row.userId) } });
      });
      runtime.on("nativeSession", event => {
        if (this.closed) return;
        if (event.sessionId !== row.nativeSessionId) { runtime.interrupt(row.userId, row.id); return; }
        row.initialized = true; this.storage.save(row);
      });
      runtime.on("serverRequest", event => {
        if (this.closed) return;
        this.approvals.set(event.id, { ...event, receivedAt: new Date().toISOString(), runtime, userId: row.userId });
        this.emit("serverRequest", event);
      });
      runtime.on("notification", (event: RpcEnvelope) => {
        if (this.closed) return;
        const params = object(event.params);
        if (event.method === "turn/started") params.turn.items = [userItem];
        if (event.method === "turn/completed") {
          try {
          params.turn.items = [userItem, ...params.turn.items];
          this.storage.saveTurn(row.id, { ...params.turn, nativeMessageId: checkpoint, nativeSessionId: row.nativeSessionId });
          row.updatedAt = Date.now();
          // Native history is already persisted by the SDK. Hashing/copying the
          // growing file synchronously every turn blocks all account streams and
          // creates quadratic disk growth. Archive only for explicit fork/move.
          // An older fork snapshot is not a recovery substitute for new turns.
          if (row.initialized) delete row.historyArchive;
          this.storage.save(row);
          } finally { this.finishRuntime(row.id); }
          for (const [id, pending] of this.approvals) if (pending.runtime === runtime) this.approvals.delete(id);
        }
        this.emit("notification", event);
      });
      setImmediate(() => void (async () => {
        if (this.closed) return;
        // Another turn on the same Claude identity can report a stop after
        // this request was accepted but before its native query starts.
        this.usage.assertAvailable(binding);
        await runtime.runTurn({ userId: row.userId, threadId: row.id, turnId, cwd: row.cwd, model: row.model, prompt,
          collaborationMode:row.collaborationMode,
          effort,
          nativeSessionId: row.nativeSessionId, ...(row.initialized ? { resumeSessionId: row.nativeSessionId } : {}) });
      })().catch(error => {
        if (this.closed) return;
        const failed = { ...turn, status: "failed", error: AppError.from(error).toPublic() };
        try { this.storage.saveTurn(row.id, failed); } finally { this.finishRuntime(row.id); }
        this.emit("notification", { method: "turn/completed", params: { threadId: row.id, turn: failed } });
      }));
      return { turn };
    });
    if (method === "turn/interrupt") { this.active.get(row.id)?.interrupt(row.userId, row.id); return {}; }
    if (method === "turn/steer") throw new AppError("unsupported_operation", "Claude 运行中请使用排队发送，或停止本轮后继续。");
    if (method === "thread/queue/add") return { queuedSubmission: this.storage.enqueue(row.id, p) };
    if (method === "thread/queue/list") return { data: this.storage.queued(row.id), nextCursor: null };
    if (method === "thread/queue/delete") { this.storage.removeQueued(row.id, p.queuedSubmissionId); return {}; }
    if (method === "thread/queue/update") { this.storage.updateQueued(row.id, p.queuedSubmissionId, p.input); return {}; }
    if (method === "thread/queue/start") {
      const entry = this.storage.queued(row.id).find(item => item.id === p.queuedSubmissionId);
      if (!entry) throw new Error("排队消息不存在。");
      const result = await this.request("turn/start", { ...entry, threadId: row.id, model: row.model });
      this.storage.removeQueued(row.id, p.queuedSubmissionId); return result;
    }
    if (method === "thread/name/set") { row.name = String(p.name); this.storage.save(row); return {}; }
    if (method === "thread/archive" || method === "thread/unarchive") { row.archived = method === "thread/archive"; this.storage.save(row); return {}; }
    if (method === "thread/settings/update") return {};
    if (method === "thread/goal/get" || method === "thread/goal/clear") return { goal: null };
    if (method === "skills/list") return { data: [{ cwd: row.cwd, skills: [], errors: [] }] };
    if (["mcpServerStatus/list", "thread/mcpServerStatus/list"].includes(method)) return { data: [], nextCursor: null };
    throw new AppError("unsupported_operation", `Claude 接入暂不支持 ${method}。`);
  }
  pending() { return [...this.approvals.values()].map(({runtime, userId, ...request}) => request); }
  answer(id: string, result: unknown) {
    const pending = this.approvals.get(id); if (!pending) throw new Error("批准请求已结束。");
    if(pending.method==="item/tool/requestUserInput")pending.runtime.answerUserInput(pending.userId,id,result);
    else pending.runtime.answerApproval(pending.userId, id, object(result).decision);
    this.approvals.delete(id);
  }
  reject(id: string) {
    const pending=this.approvals.get(id);if(!pending)throw new Error("请求已结束。");
    pending.runtime.rejectRequest(pending.userId,id);this.approvals.delete(id);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.authorization.close();
    if (this.usageTimer) clearInterval(this.usageTimer);
    for (const [id, runtime] of this.active) runtime.interrupt(this.row(id).userId, id);
    this.active.clear(); this.approvals.clear(); this.storage.close();
  }
}

export async function offlineFork(sessionId: string, configRoot: string, title: string, cutoff?: string): Promise<string> {
  const result = await run("/usr/bin/python3", [path.join(scripts, "claude-offline-network-guard.py"), process.execPath,
    path.join(scripts, "claude-offline-fork.mjs"), sessionId, "", title, cutoff ?? ""],
    { env: { ...process.env, CLAUDE_CONFIG_DIR: configRoot }, timeout: 120_000, maxBuffer: 1024 * 1024 });
  const id = JSON.parse(result.stdout.trim()).sessionId;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || id === sessionId) throw new Error("Invalid offline fork identity.");
  return id;
}

/** Preserve the existing bridge/event pipeline for authentication, ownership,
 * streaming, approvals, scheduled turns and normal automatic continuation. */
export function withClaudeService<T extends CodexBridge>(base: T, store: ProjectStore, config?: ClaudeIntegrationConfig): T {
  if (!config) return base;
  const service = new ClaudeService(config, store, (type, event) => base.emit(type, event));
  const request = (method: string, params?: unknown, timeout?: number) => {
    const p = object(params), id = String(p.threadId ?? "");
    if (service.owns(id) || (method === "thread/start" && isReclaudeModel(p.model))) return service.request(method, p);
    return base.request(method, params, timeout);
  };
  const proxy = new Proxy(base, { get(target, key) {
    if (key === "request") return request;
    if (key === "getPendingServerRequests") return () => [...base.getPendingServerRequests(), ...service.pending()];
    if (key === "respondToServerRequest") return (id: string | number, result: unknown) => typeof id === "string" && /^(claude-approval|claude-input):/.test(id) ? service.answer(id, result) : base.respondToServerRequest(id, result);
    if (key === "rejectServerRequest") return (id: string | number, message: string) => typeof id === "string" && /^(claude-approval|claude-input):/.test(id) ? service.reject(id) : base.rejectServerRequest(id, message);
    if (key === "requestOnThreadAccount") return (id: string, method: string, params: unknown, timeout?: number) => service.owns(id) ? service.request(method, { ...object(params), threadId: id }) : (target as any).requestOnThreadAccount ? (target as any).requestOnThreadAccount(id, method, params, timeout) : base.request(method, params, timeout);
    if (key === "startThreadOnAccount") return (account: string, params: unknown, timeout?: number) => isReclaudeModel(object(params).model) ? request("thread/start", params, timeout) : (target as any).startThreadOnAccount(account, params, timeout);
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  services.set(proxy, service);
  return proxy;
}
