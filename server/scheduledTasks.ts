import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ScheduleRule =
  | { kind: "once"; at: string; timezone: string }
  | { kind: "interval"; intervalMinutes: number; timezone: string }
  | { kind: "daily" | "weekdays"; time: string; timezone: string }
  | { kind: "weekly"; time: string; weekdays: number[]; timezone: string };
export interface ScheduledTask {
  id: string; userId: string; projectId: string; threadId: string; title: string; prompt: string;
  schedule: ScheduleRule; enabled: boolean; status: "scheduled" | "paused" | "dispatching" | "queued" | "failed" | "completed";
  pendingRun?: boolean;
  createdAt: string; updatedAt: string; nextRunAt: string | null; lastRunAt?: string; lastError?: string;
  history: Array<{ id: string; scheduledAt: string; status: "dispatching" | "queued" | "failed" | "skipped" | "completed"; error?: string; warning?: string }>;
}
export class ScheduleConflictError extends Error {}
type State = { tasks: ScheduledTask[] };
const MAX_PER_THREAD = 20;
const MAX_PER_USER = 100;
const MAX_HISTORY = 50;
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (timezone: string) => {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, value);
    if (formatters.size > 64) formatters.delete(formatters.keys().next().value!);
  } else { formatters.delete(timezone); formatters.set(timezone, value); }
  return value;
};
const validZone = (zone: string) => { try { formatter(zone); return true; } catch { return false; } };
const zonedParts = (date: Date, timezone: string) => {
  const parts = formatter(timezone).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return { year: +get("year"), month: +get("month"), day: +get("day"), hour: +get("hour"), minute: +get("minute"), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
};
export function nextScheduleAt(rule: ScheduleRule, after = Date.now()): number | null {
  if (rule.kind === "once") { const n = Date.parse(rule.at); return Number.isFinite(n) && n > after ? n : null; }
  if (rule.kind === "interval") return after + rule.intervalMinutes * 60_000;
  const [hour, minute] = rule.time.split(":").map(Number);
  const afterParts = zonedParts(new Date(after), rule.timezone);
  const afterDay = `${afterParts.year}-${afterParts.month}-${afterParts.day}`;
  const skipAfterDay = afterParts.hour > hour || (afterParts.hour === hour && afterParts.minute >= minute);
  // Minute scan honors IANA timezone transitions and local wall-clock semantics.
  const start = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (let t = start; t <= after + 9 * 86_400_000; t += 60_000) {
    const p = zonedParts(new Date(t), rule.timezone);
    if (skipAfterDay && `${p.year}-${p.month}-${p.day}` === afterDay) continue;
    if (p.hour !== hour || p.minute !== minute) continue;
    if (rule.kind === "weekdays" && (p.weekday < 1 || p.weekday > 5)) continue;
    if (rule.kind === "weekly" && !rule.weekdays.includes(p.weekday)) continue;
    return t;
  }
  return null;
}
export function validateScheduleRule(rule: ScheduleRule): void {
  if (!validZone(rule.timezone)) throw new Error("Unknown timezone.");
  if (rule.kind === "once") { if (!Number.isFinite(Date.parse(rule.at)) || Date.parse(rule.at) <= Date.now()) throw new Error("One-shot schedule must be in the future."); return; }
  if (rule.kind === "interval") { if (!Number.isInteger(rule.intervalMinutes) || rule.intervalMinutes < 5 || rule.intervalMinutes > 525600) throw new Error("Interval must be 5 minutes or longer."); return; }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) throw new Error("Time must use HH:mm.");
  if (rule.kind === "weekly" && (!rule.weekdays.length || rule.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error("Weekly schedule requires weekdays 0–6.");
}
function isPersistedState(value: unknown): value is State {
  if (!value || typeof value !== "object" || !Array.isArray((value as State).tasks)) return false;
  return (value as State).tasks.every((task: any) => {
    if (!task || typeof task !== "object" || typeof task.id !== "string" || typeof task.userId !== "string" || typeof task.projectId !== "string" || typeof task.threadId !== "string" || typeof task.prompt !== "string" || typeof task.title !== "string" || typeof task.enabled !== "boolean" || !Array.isArray(task.history)) return false;
    if (task.pendingRun !== undefined && typeof task.pendingRun !== "boolean") return false;
    if (!["scheduled", "paused", "dispatching", "queued", "failed", "completed"].includes(task.status)) return false;
    try {
      if (task.schedule?.kind === "once") { if (!Number.isFinite(Date.parse(task.schedule.at)) || !validZone(task.schedule.timezone)) return false; }
      else validateScheduleRule(task.schedule);
    } catch { return false; }
    return task.history.every((run: any) => run && typeof run.id === "string" && typeof run.scheduledAt === "string" && ["dispatching", "queued", "failed", "skipped", "completed"].includes(run.status));
  });
}
export class ScheduledTaskStore {
  private state: State;
  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isPersistedState(parsed)) throw new Error(`Invalid scheduled task data at ${file}; refusing to overwrite it.`);
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.state = { tasks: [] };
      else throw error;
    }
    // A process died between claiming and receiving queue/add's result. Never resend an uncertain claim.
    for (const task of this.state.tasks) {
      task.history = task.history.slice(-MAX_HISTORY);
      if (task.status !== "dispatching") continue;
      task.status = "failed"; task.enabled = false; task.nextRunAt = null; task.lastError = "Server restarted during dispatch; not resent to avoid duplicates.";
      const last = task.history.at(-1); if (last?.status === "dispatching") { last.status = "failed"; last.error = task.lastError; }
    }
    this.save();
  }
  private save() { const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
  list(userId: string, projectId: string, threadId: string) { return this.state.tasks.filter(t => t.userId === userId && t.projectId === projectId && t.threadId === threadId).map(t => structuredClone(t)); }
  create(input: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt" | "status" | "nextRunAt" | "history">): ScheduledTask {
    if (this.state.tasks.filter(t => t.userId === input.userId).length >= MAX_PER_USER || this.state.tasks.filter(t => t.userId === input.userId && t.threadId === input.threadId).length >= MAX_PER_THREAD) throw new Error("Scheduled task limit reached.");
    validateScheduleRule(input.schedule);
    const now = new Date().toISOString(); const task: ScheduledTask = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, status: input.enabled ? "scheduled" : "paused", nextRunAt: input.enabled ? new Date(nextScheduleAt(input.schedule)!).toISOString() : null, history: [] };
    this.state.tasks.push(task); this.save(); return structuredClone(task);
  }
  update(id: string, userId: string, patch: Partial<Pick<ScheduledTask, "title" | "prompt" | "schedule" | "enabled">>): ScheduledTask | null {
    const t = this.state.tasks.find(x => x.id === id && x.userId === userId); if (!t) return null;
    if (t.status === "dispatching") throw new ScheduleConflictError("Scheduled run is being dispatched; wait before editing it.");
    if (patch.schedule) validateScheduleRule(patch.schedule);
    if (patch.enabled === true && t.schedule.kind === "once" && !patch.schedule && (Date.parse(t.schedule.at) <= Date.now() || t.history.length > 0)) throw new ScheduleConflictError("Choose a new future time before resuming this one-shot schedule.");
    Object.assign(t, patch); t.updatedAt = new Date().toISOString();
    if (patch.schedule || patch.enabled === true) { t.status = t.enabled ? "scheduled" : "paused"; const next = t.enabled ? nextScheduleAt(t.schedule) : null; t.nextRunAt = next ? new Date(next).toISOString() : null; }
    if (patch.enabled === false) { t.status = "paused"; t.nextRunAt = null; } this.save(); return structuredClone(t);
  }
  delete(id: string, userId: string) { const task = this.state.tasks.find(t => t.id === id && t.userId === userId); if (task?.status === "dispatching") throw new ScheduleConflictError("Scheduled run is being dispatched; wait before deleting it."); const n = this.state.tasks.length; this.state.tasks = this.state.tasks.filter(t => t.id !== id || t.userId !== userId); if (n !== this.state.tasks.length) this.save(); return n !== this.state.tasks.length; }
  due(now = Date.now()) { return this.state.tasks.filter(t => t.enabled && t.nextRunAt && Date.parse(t.nextRunAt) <= now && t.status !== "dispatching").map(t => structuredClone(t)); }
  claim(id: string, dueAt: number): string | null { const t = this.state.tasks.find(x => x.id === id); if (!t || !t.enabled || t.status === "dispatching" || !t.nextRunAt || Date.parse(t.nextRunAt) > dueAt) return null;
    const runId = randomUUID(); t.status = "dispatching"; t.lastRunAt = new Date(dueAt).toISOString(); t.history.push({ id: runId, scheduledAt: t.lastRunAt, status: "dispatching" }); t.history = t.history.slice(-MAX_HISTORY); t.updatedAt = new Date().toISOString(); this.save(); return runId; }
  finish(id: string, runId: string, error?: string, now = Date.now(), skipped = false, warning?: string) { const t = this.state.tasks.find(x => x.id === id); const h = t?.history.find(x => x.id === runId); if (!t || !h) return;
    const success = !error; h.status = skipped ? "skipped" : success ? "queued" : "failed"; if (error) h.error = error; if (warning) h.warning = warning; t.status = success ? "queued" : "failed"; t.lastError = error ?? warning; t.updatedAt = new Date().toISOString();
    if (!success) t.pendingRun = false; else if (!skipped) t.pendingRun = true;
    if (!success) { t.enabled = false; t.nextRunAt = null; }
    if (t.schedule.kind === "once") { t.enabled = false; t.nextRunAt = null; }
    else if (success && t.enabled) { const next = nextScheduleAt(t.schedule, Math.max(now, Date.parse(t.lastRunAt ?? "")) + 1000); t.nextRunAt = next ? new Date(next).toISOString() : null; t.status = "scheduled"; }
    this.save(); }
}

export async function queueScheduledPrompt(
  bridge: { request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> },
  task: ScheduledTask,
  runId: string
): Promise<{ queued: boolean; warning?: string }> {
  if (task.pendingRun) {
    const previous = await bridge.request("thread/read", { threadId: task.threadId, includeTurns: false }, 30_000) as { thread?: { status?: { type?: string } | string } };
    const previousStatus = typeof previous.thread?.status === "string" ? previous.thread.status : previous.thread?.status?.type;
    if (previousStatus !== "idle") return { queued: false };
  }
  const clientUserMessageId = `schedule:${task.id}:${runId}`;
  const pending = await bridge.request("thread/queue/list", { threadId: task.threadId, limit: 100 }, 30_000) as { data?: Array<{ clientUserMessageId?: string; input?: Array<{ type?: string; text?: string }> }> };
  if (pending.data?.some(item => item.clientUserMessageId?.startsWith(`schedule:${task.id}:`)
    || (task.pendingRun && item.input?.filter(part => part.type === "text").map(part => part.text ?? "").join(" ").trim() === task.prompt))) return { queued: false };
  await bridge.request("thread/queue/add", { threadId: task.threadId, input: [{ type: "text", text: task.prompt, text_elements: [] }], clientUserMessageId }, 30_000);
  try {
    const latest = await bridge.request("thread/read", { threadId: task.threadId, includeTurns: false }, 30_000) as { thread?: { status?: { type?: string } | string } };
    const status = typeof latest.thread?.status === "string" ? latest.thread.status : latest.thread?.status?.type;
    if (status !== "idle") return { queued: true, ...(status ? {} : { warning: "Prompt is queued; native thread status could not be confirmed for automatic start." }) };
    const queue = await bridge.request("thread/queue/list", { threadId: task.threadId, limit: 1 }, 30_000) as { data?: Array<{ id?: string }> };
    const queuedSubmissionId = queue.data?.[0]?.id;
    if (queuedSubmissionId) await bridge.request("thread/queue/start", { threadId: task.threadId, queuedSubmissionId }, 30_000);
    return { queued: true };
  } catch (error) {
    // queue/add has succeeded. Socket completion/start handling may win the
    // race for queue/start; never report this accepted run as retryable.
    return { queued: true, warning: `Prompt is queued but automatic start could not be confirmed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function resumeThreadIfUnloaded(
  bridge: {
    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
    requestOnThreadAccount?: (threadId: string, method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  },
  threadId: string,
  cwd: string,
  config?: unknown
): Promise<boolean> {
  const request = bridge.requestOnThreadAccount
    ? (method: string, params?: unknown, timeoutMs?: number) => bridge.requestOnThreadAccount!(threadId, method, params, timeoutMs)
    : (method: string, params?: unknown, timeoutMs?: number) => bridge.request(method, params, timeoutMs);
  const loaded = await request("thread/loaded/list", {}, 30_000) as { data?: string[] };
  if (loaded.data?.includes(threadId)) return false;
  // thread/resume by ID reloads its native persisted history. Omitting model,
  // sandbox and approval overrides preserves the conversation's own settings.
  await request("thread/resume", { threadId, cwd, config, excludeTurns: true }, 30_000);
  return true;
}
