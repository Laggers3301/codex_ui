import type { SideChat, SideChatChange, SideChatStatus, ThreadSummary } from "./types";

export interface TemporaryAsk {
  id: string;
  userId: string;
  parentThreadId: string;
  requestId: string;
  projectId: string;
  threadId: string | null;
  selectedText: string;
  prompt: string;
  prompts: Array<{ requestId: string; turnId: string | null; text: string; createdAt: number }>;
  turnId: string | null;
  status: SideChatStatus;
  error?: string | null;
}

export interface SideChatSession {
  record: SideChat;
  ask: TemporaryAsk;
  thread: ThreadSummary | null;
  draft: string;
  modelProfileId: string;
  dirty: boolean;
  pendingRequestId?: string;
}

interface SideChatApi {
  read(project: string, parent: string): Promise<{ data: SideChat | null }>;
  create(project: string, parent: string, text: string, model: string): Promise<{ data: SideChat }>;
  save(side: SideChat, draft: string, model: string, keepalive?: boolean): Promise<{ data: SideChat }>;
  remove(side: SideChat): Promise<{ data: SideChat | null }>;
  readThread(thread: string, project: string): Promise<ThreadSummary>;
}

export const sideChatKey = (userId: string, parentThreadId: string) => JSON.stringify([userId, parentThreadId]);

export class SideChatController {
  private sessions = new Map<string, SideChatSession>();
  private loads = new Map<string, Promise<void>>();
  private opens = new Map<string, Promise<void>>();
  private saves = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private closedIds = new Set<string>();
  private revision = 0;
  activeKey: string | null = null;

  constructor(private api: SideChatApi, private onError: (message: string) => void) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.revision;
  get(user: string, parent: string): SideChatSession | null { return this.sessions.get(sideChatKey(user, parent)) ?? null; }
  forThread(threadId: string): SideChatSession | null { return [...this.sessions.values()].find(session => session.ask.threadId === threadId) ?? null; }
  forRequest(requestId: string): SideChatSession | null { return [...this.sessions.values()].find(session => session.ask.requestId === requestId) ?? null; }
  threadIds(): Set<string> { return new Set([...this.sessions.values()].flatMap(session => session.ask.threadId ? [session.ask.threadId] : [])); }

  private publish(key: string): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  private report(key: string, error: unknown): void {
    if (key === this.activeKey) this.onError(error instanceof Error ? error.message : String(error));
  }

  receive(change: SideChatChange): void {
    const key = sideChatKey(change.userId, change.parentThreadId);
    if (change.sideChat) { this.apply(change.sideChat); return; }
    this.closedIds.add(change.id);
    if (this.closedIds.size > 1024) this.closedIds.delete(this.closedIds.values().next().value!);
    const previous = this.sessions.get(key);
    if (previous && previous.record.id !== change.id) return;
    this.cancelSave(key);
    this.sessions.delete(key);
    this.publish(key);
  }

  private apply(record: SideChat): void {
    if (this.closedIds.has(record.id)) return;
    const key = sideChatKey(record.userId, record.parentThreadId), previous = this.sessions.get(key);
    const same = previous?.record.id === record.id;
    if (same && previous.record.revision > record.revision) return;
    const prompts = same ? [...previous.ask.prompts] : [];
    if (record.requestId && record.lastPrompt) {
      const index = prompts.findIndex(prompt => prompt.requestId === record.requestId);
      const prompt = { requestId: record.requestId, turnId: record.turnId, text: record.lastPrompt, createdAt: Date.parse(record.updatedAt) };
      if (index < 0) prompts.push(prompt); else prompts[index] = prompt;
    }
    const pending = same && previous.pendingRequestId && previous.pendingRequestId !== record.requestId;
    const ask: TemporaryAsk = pending ? previous.ask : {
      id: record.id, userId: record.userId, parentThreadId: record.parentThreadId, projectId: record.projectId,
      requestId: record.requestId ?? record.id, threadId: record.threadId, selectedText: record.selectedText,
      prompt: record.lastPrompt, prompts, turnId: record.turnId, status: record.status, error: record.error
    };
    this.sessions.set(key, {
      record, ask, thread: same && previous.thread?.id === record.threadId ? previous.thread : null,
      draft: same && (previous.dirty || pending) ? previous.draft : record.draft,
      modelProfileId: same && previous.dirty ? previous.modelProfileId : record.modelProfileId,
      dirty: Boolean(same && previous.dirty), pendingRequestId: pending ? previous.pendingRequestId : undefined
    });
    this.publish(key);
  }

  async load(user: string, project: string, parent: string): Promise<void> {
    const key = sideChatKey(user, parent);
    if (this.loads.has(key)) return this.loads.get(key);
    const recordAtStart = this.sessions.get(key)?.record;
    const promise = (async () => {
      try {
        const { data } = await this.api.read(project, parent);
        if (this.sessions.get(key)?.record !== recordAtStart) return;
        if (!data) {
          const previous = this.sessions.get(key);
          if (previous) this.receive({ ...previous.record, sideChat: null });
          else this.publish(key);
          return;
        }
        if (data.userId !== user || data.parentThreadId !== parent || data.projectId !== project) throw new Error("侧边会话关联不匹配。");
        this.apply(data);
        await this.loadThread(data);
      } catch (error) { this.report(key, error); }
    })().finally(() => this.loads.delete(key));
    this.loads.set(key, promise);
    return promise;
  }

  async loadThread(side: SideChat): Promise<void> {
    if (!side.threadId) return;
    const key = sideChatKey(side.userId, side.parentThreadId);
    try {
      const thread = await this.api.readThread(side.threadId, side.projectId);
      const current = this.sessions.get(key);
      if (current?.record.id !== side.id || current.ask.threadId !== thread.id) return;
      if (current.thread && current.record.revision > side.revision) return;
      this.sessions.set(key, { ...current, thread }); this.publish(key);
    } catch (error) { this.report(key, error); }
  }

  async open(user: string, project: string, parent: string, text: string, model: string): Promise<void> {
    const key = sideChatKey(user, parent);
    if (this.sessions.has(key)) return;
    if (this.opens.has(key)) return this.opens.get(key);
    const promise = (async () => {
      await this.load(user, project, parent);
      if (this.sessions.has(key)) return;
      try {
        const { data } = await this.api.create(project, parent, text, model);
        this.apply(data); await this.loadThread(data);
      } catch (error) { this.report(key, error); }
    })().finally(() => this.opens.delete(key));
    this.opens.set(key, promise); return promise;
  }

  setDraft(user: string, parent: string, draft: string, model?: string): void {
    const key = sideChatKey(user, parent), session = this.sessions.get(key);
    if (!session || session.ask.status === "closing") return;
    this.sessions.set(key, { ...session, draft, modelProfileId: model ?? session.modelProfileId, dirty: true });
    this.publish(key); this.cancelSave(key);
    this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.flush(key); }, 250));
  }

  private cancelSave(key: string): void {
    const timer = this.timers.get(key); if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  async flush(key: string, keepalive = false): Promise<void> {
    this.cancelSave(key);
    const previous = this.saves.get(key) ?? Promise.resolve();
    const promise = previous.then(async () => {
      const session = this.sessions.get(key);
      if (!session?.dirty) return;
      const { record, draft, modelProfileId } = session;
      try {
        const { data } = await this.api.save(record, draft, modelProfileId, keepalive);
        const current = this.sessions.get(key);
        if (current?.record.id !== record.id || current.record.requestId !== record.requestId) return;
        if (current.draft === draft && current.modelProfileId === modelProfileId) this.sessions.set(key, { ...current, dirty: false });
        this.apply(data);
      } catch (error) {
        if (this.sessions.get(key)?.record.id === record.id && this.sessions.get(key)?.ask.requestId === session.ask.requestId) this.report(key, error);
      }
    }).finally(() => { if (this.saves.get(key) === promise) this.saves.delete(key); });
    this.saves.set(key, promise); return promise;
  }

  begin(user: string, parent: string, requestId: string, text: string): TemporaryAsk | null {
    const key = sideChatKey(user, parent), session = this.sessions.get(key);
    if (!session || ["starting", "running", "closing"].includes(session.ask.status)) return null;
    this.cancelSave(key);
    const ask = { ...session.ask, requestId, prompt: text, turnId: null, status: "starting" as const,
      prompts: [...session.ask.prompts, { requestId, turnId: null, text, createdAt: Date.now() }] };
    this.sessions.set(key, { ...session, ask, draft: "", dirty: false, pendingRequestId: requestId });
    this.publish(key); return ask;
  }

  updateAsk(ask: TemporaryAsk): void {
    const key = sideChatKey(ask.userId, ask.parentThreadId), session = this.sessions.get(key);
    if (!session || session.ask.id !== ask.id) return;
    this.sessions.set(key, { ...session, ask, pendingRequestId: ask.status === "starting" ? session.pendingRequestId : undefined });
    this.publish(key);
  }

  updateThread(threadId: string, update: (current: ThreadSummary | null) => ThreadSummary): void {
    const session = this.forThread(threadId); if (!session) return;
    const key = sideChatKey(session.record.userId, session.record.parentThreadId);
    this.sessions.set(key, { ...session, thread: update(session.thread) }); this.publish(key);
  }

  async close(ask: TemporaryAsk): Promise<void> {
    const key = sideChatKey(ask.userId, ask.parentThreadId), session = this.sessions.get(key);
    if (!session || session.record.id !== ask.id) return;
    this.cancelSave(key);
    try {
      const { data } = await this.api.remove(session.record);
      if (data) this.apply(data);
      else this.receive({ id: ask.id, userId: ask.userId, projectId: ask.projectId, parentThreadId: ask.parentThreadId, sideChat: null });
    } catch (error) { this.report(key, error); }
  }

  flushAll(keepalive = false): void {
    for (const [key, session] of this.sessions) if (session.dirty) void this.flush(key, keepalive);
  }
}
