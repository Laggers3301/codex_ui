import type { CodexBridge } from './codexBridge.js';
import type { ProjectStore } from './db.js';
import type { ConversationTask, ConversationTasksResponse } from '../shared/conversationTasks.js';
import { AppError } from './appErrors.js';

export interface StoredBackgroundTask extends ConversationTask { processId: string; }
type Value = Record<string, any>;
const object = (value: unknown): Value => value && typeof value === 'object' ? value as Value : {};
const terminalState = (item: Value): ConversationTask['status'] => item.status === 'failed' || item.status === 'declined' || typeof item.exitCode === 'number' && item.exitCode !== 0
  ? 'failed' : item.status === 'completed' ? 'completed' : 'running';

/** The native terminal directory proves a command is a background job. Merely
 * seeing a shell tool call, or an empty directory, never proves completion. */
export class CodexBackgroundTasks {
  private readonly items = new Map<string, Value>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, Promise<ConversationTasksResponse>>();
  private closed = false;
  constructor(private bridge: CodexBridge, private store: ProjectStore) {
    if (typeof bridge.on === 'function') bridge.on('notification', this.notification);
  }
  close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (typeof this.bridge.off === 'function') this.bridge.off('notification', this.notification);
  }
  private key(threadId: string, itemId: string) { return `${threadId}:${itemId}`; }
  private notification = (envelope: Value) => {
    if (this.closed) return;
    const params = object(envelope.params), item = object(params.item), threadId = params.threadId;
    if (typeof threadId !== 'string') return;
    const owner = this.store.getThreadOwner(threadId);
    if (!owner) return;
    if (['item/started', 'item/completed'].includes(envelope.method) && item.type === 'commandExecution' && typeof item.id === 'string') {
      const key = this.key(threadId, item.id), old = this.items.get(key);
      const next = { ...old, id: item.id, command: String(item.command ?? old?.command ?? '').slice(0, 500),
        processId: item.processId ?? old?.processId, status: item.status ?? (envelope.method === 'item/completed' ? 'completed' : 'inProgress'),
        exitCode: item.exitCode, summary: String(item.aggregatedOutput ?? old?.summary ?? '').slice(-4096), updatedAt: Date.now() };
      this.items.set(key, next);
      while (this.items.size > 1000) this.items.delete(this.items.keys().next().value!);
      if (envelope.method === 'item/completed') {
        const saved = this.store.getBackgroundTasks(threadId, owner.userId), known = saved.find(task => task.id === item.id);
        if (known) this.store.saveBackgroundTasks(threadId, owner.userId, saved.map(task => task === known ? this.merge(task, next) : task));
      } else if (typeof next.processId === 'string' && !this.timers.has(threadId)) {
        const timer = setTimeout(() => {
          this.timers.delete(threadId);
          void this.read(owner.userId, threadId).catch(() => {});
        }, 150);
        timer.unref?.(); this.timers.set(threadId, timer);
      }
    } else if (envelope.method === 'item/commandExecution/outputDelta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
      const item = this.items.get(this.key(threadId, params.itemId));
      if (item) { item.summary = (item.summary + params.delta).slice(-4096); item.updatedAt = Date.now(); }
    }
  };
  private merge(task: StoredBackgroundTask, item: Value): StoredBackgroundTask {
    return { ...task, status: terminalState(item), description: item.command || task.description,
      summary: item.summary || task.summary, updatedAt: item.updatedAt || task.updatedAt };
  }
  read(userId: string, threadId: string): Promise<ConversationTasksResponse> {
    if (this.store.getThreadOwner(threadId)?.userId !== userId) return Promise.reject(new AppError('runtime_forbidden', '无法读取其他用户的任务。'));
    const key = `${userId}:${threadId}`, current = this.pending.get(key);
    if (current) return current;
    const work = this.reconcile(userId, threadId).finally(() => { this.pending.delete(key); });
    this.pending.set(key, work); return work;
  }
  private async reconcile(userId: string, threadId: string): Promise<ConversationTasksResponse> {
    const saved = this.store.getBackgroundTasks(threadId, userId);
    let response: Value, supported = true, unavailable = false;
    try {
      response = object(await this.bridge.request('thread/backgroundTerminals/list', { threadId, limit: 100 }, 10000));
      if (!Array.isArray(response.data)) throw Error('原生后台任务列表格式不正确。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/method not found|unknown (?:request|method|variant)|unsupported.*backgroundTerminals/i.test(message)) { supported = false; unavailable = true; }
      else if (/thread.*(?:not (?:loaded|found)|unavailable)|no (?:loaded )?thread|not (?:loaded|found).*thread/i.test(message)) unavailable = true;
      else throw error;
      response = { data: [] };
    }
    if (this.closed) return { data: [], supported };
    if (this.store.getThreadOwner(threadId)?.userId !== userId) throw new AppError('runtime_forbidden', '任务所属用户已改变。');
    const records = new Map(saved.map(task => [task.id, task])), live = new Set<string>();
    for (const value of response.data) {
      const row = object(value);
      if (typeof row.itemId !== 'string' || typeof row.processId !== 'string') continue;
      live.add(row.itemId);
      const known = records.get(row.itemId), item = this.items.get(this.key(threadId, row.itemId));
      const task: StoredBackgroundTask = { id: row.itemId, processId: row.processId, kind: 'shell',
        description: String(row.command ?? known?.description ?? '后台命令').slice(0, 500), status: 'running', background: true,
        ...(known?.summary ? { summary: known.summary } : {}), updatedAt: known?.updatedAt ?? Date.now() };
      records.set(row.itemId, item ? this.merge(task, item) : task);
    }
    for (const [id, task] of records) {
      const item = this.items.get(this.key(threadId, id));
      if (item) records.set(id, this.merge(task, item));
      const latest = records.get(id)!;
      if (latest.status === 'running' && !live.has(id) && (unavailable || !response.nextCursor)) records.set(id, { ...latest, status: 'unknown' });
    }
    const tasks = [...records.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 100);
    if (JSON.stringify(saved) !== JSON.stringify(tasks)) this.store.saveBackgroundTasks(threadId, userId, tasks);
    // Explicit projection: native process IDs, cwd, OS PIDs and resource counters stay private.
    return { supported, data: tasks.map(task => ({ id: task.id, kind: task.kind, description: task.description,
      status: task.status, background: task.background, ...(task.summary ? { summary: task.summary } : {}),
      ...(task.updatedAt ? { updatedAt: task.updatedAt } : {}) })) };
  }
}
