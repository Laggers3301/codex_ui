import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextScheduleAt, queueScheduledPrompt, resumeThreadIfUnloaded, ScheduledTaskStore, validateScheduleRule } from "./scheduledTasks.js";

const tempDirs: string[] = [];
function store() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-tasks-")); tempDirs.push(dir); return { store: new ScheduledTaskStore(path.join(dir, "tasks.json")), file: path.join(dir, "tasks.json") }; }
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const base = { userId: "u", projectId: "p", threadId: "t", title: "test", prompt: "hello", schedule: { kind: "interval" as const, intervalMinutes: 5, timezone: "UTC" }, enabled: true };

describe("scheduled task persistence and claims", () => {
  it("persists tasks and refuses duplicate claims", () => {
    const { store: s, file } = store();
    const task = s.create(base);
    expect(new ScheduledTaskStore(file).list("u", "p", "t")).toHaveLength(1);
    const runId = s.claim(task.id, Date.parse(task.nextRunAt!));
    expect(runId).toBeTruthy();
    expect(s.claim(task.id, Date.now() + 60_000)).toBeNull();
    s.finish(task.id, runId!, "quota unavailable");
    expect(s.list("u", "p", "t")[0].lastError).toContain("quota");
  });
  it("marks uncertain in-flight dispatch failed on restart and does not resend", () => {
    const { store: s, file } = store(); const task = s.create(base); s.claim(task.id, Date.parse(task.nextRunAt!));
    const recovered = new ScheduledTaskStore(file).list("u", "p", "t")[0];
    expect(recovered.status).toBe("failed"); expect(recovered.enabled).toBe(false); expect(recovered.nextRunAt).toBeNull();
  });
  it("supports weekly local time across timezone conversion and validates interval minimum", () => {
    const rule = { kind: "weekly" as const, time: "09:30", weekdays: [1], timezone: "Asia/Shanghai" };
    const mondayMorning = Date.parse("2026-10-05T00:00:00Z");
    expect(new Date(nextScheduleAt(rule, mondayMorning - 1)!).toISOString()).toBe("2026-10-05T01:30:00.000Z");
    const repeatedHourRule = { kind: "daily" as const, time: "01:30", timezone: "America/New_York" };
    expect(new Date(nextScheduleAt(repeatedHourRule, Date.parse("2026-11-01T05:30:00Z"))!).toISOString()).toBe("2026-11-02T06:30:00.000Z");
    expect(() => validateScheduleRule({ kind: "interval", intervalMinutes: 4, timezone: "UTC" })).toThrow();
  });
  it("scopes listings by user, project, and conversation", () => {
    const { store: s } = store(); const first = s.create(base);
    s.create({ ...base, projectId: "other-project" }); s.create({ ...base, threadId: "other-thread" }); s.create({ ...base, userId: "other-user" });
    expect(s.list("u", "p", "t").map(task => task.id)).toEqual([first.id]);
  });
  it("queues with the exact native payload and starts only when the thread is idle", async () => {
    const { store: s } = store(); const task = s.create(base); const calls: Array<[string, any]> = [];
    let queueLists = 0;
    const bridge = { request: async (method: string, params?: any) => {
      calls.push([method, params]);
      if (method === "thread/read") return { thread: { status: { type: "idle" } } };
      if (method === "thread/queue/list") return ++queueLists === 1 ? { data: [] } : { data: [{ id: "queued-id" }] };
      return {};
    } };
    expect(await queueScheduledPrompt(bridge, task, "stable-run")).toEqual({ queued: true });
    expect(calls.map(([method]) => method)).toEqual(["thread/queue/list", "thread/queue/add", "thread/read", "thread/queue/list", "thread/queue/start"]);
    expect(calls[1][1]).toEqual({ threadId: "t", input: [{ type: "text", text: "hello", text_elements: [] }], clientUserMessageId: `schedule:${task.id}:stable-run` });
    expect(calls[4][1]).toEqual({ threadId: "t", queuedSubmissionId: "queued-id" });

    calls.length = 0; bridge.request = async (method: string, params?: any) => { calls.push([method, params]); if (method === "thread/queue/list") return { data: [] }; if (method === "thread/read") return { thread: { status: { type: "active" } } }; return {}; };
    expect(await queueScheduledPrompt(bridge, task, "busy-run")).toEqual({ queued: true });
    expect(calls.map(([method]) => method)).toEqual(["thread/queue/list", "thread/queue/add", "thread/read"]);
  });
  it("coalesces a due recurrence while its prior scheduled run remains active", async () => {
    const { store: s } = store(); const task = s.create(base); const run = s.claim(task.id, Date.parse(task.nextRunAt!))!; s.finish(task.id, run);
    const due = s.list("u", "p", "t")[0]; const skippedRun = s.claim(task.id, Date.parse(due.nextRunAt!))!;
    const calls: string[] = [];
    const shouldQueue = await queueScheduledPrompt({ request: async method => { calls.push(method); return { thread: { status: { type: "active" } } }; } }, due, "next-run");
    expect(shouldQueue).toEqual({ queued: false }); expect(calls).toEqual(["thread/read"]);
    s.finish(task.id, skippedRun, undefined, Date.now(), true);
    expect(s.list("u", "p", "t")[0].pendingRun).toBe(true);
  });
  it("lazily resumes an unloaded thread by ID without overriding its model or policy", async () => {
    const calls: Array<[string, unknown, unknown]> = [];
    const bridge = {
      request: async () => { throw new Error("account-agnostic request should not be used"); },
      requestOnThreadAccount: async (_threadId: string, method: string, params: unknown) => {
        calls.push([method, params, _threadId]);
        return method === "thread/loaded/list" ? { data: [] } : {};
      }
    };
    const config = { browser: "thread-scoped" };
    expect(await resumeThreadIfUnloaded(bridge, "thread-7", "/project", config)).toBe(true);
    expect(calls).toEqual([
      ["thread/loaded/list", {}, "thread-7"],
      ["thread/resume", { threadId: "thread-7", cwd: "/project", config, excludeTurns: true }, "thread-7"]
    ]);
  });
  it("does not resume a thread already loaded by the native app server", async () => {
    const calls: string[] = [];
    const resumed = await resumeThreadIfUnloaded({ request: async (method: string) => { calls.push(method); return { data: ["thread-7"] }; } }, "thread-7", "/project");
    expect(resumed).toBe(false); expect(calls).toEqual(["thread/loaded/list"]);
  });
  it("retains an accepted queue when socket dispatch wins the queue/start race", async () => {
    const { store: s } = store(); const task = s.create(base);
    const result = await queueScheduledPrompt({ request: async (method: string) => {
      if (method === "thread/queue/list") return { data: [{ id: "queued-id" }] };
      if (method === "thread/read") return { thread: { status: { type: "idle" } } };
      if (method === "thread/queue/start") throw new Error("Queued submission was already started.");
      return {};
    } }, task, "race-run");
    expect(result.queued).toBe(true); expect(result.warning).toContain("could not be confirmed");
  });
  it("bounds run history", () => {
    const { store: s } = store(); const task = s.create(base);
    for (let i = 0; i < 55; i++) { const current = s.list("u", "p", "t")[0]; const id = s.claim(task.id, Date.parse(current.nextRunAt!))!; s.finish(task.id, id); }
    expect(s.list("u", "p", "t")[0].history).toHaveLength(50);
  });
  it("fails closed on corrupt persisted state and rejects resuming an expired one-shot", () => {
    const { store: s, file } = store(); const task = s.create(base); s.update(task.id, "u", { enabled: true });
    fs.writeFileSync(file, "{broken", "utf8"); expect(() => new ScheduledTaskStore(file)).toThrow();
    const once = s.create({ ...base, schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString(), timezone: "UTC" } });
    const claimed = s.claim(once.id, Date.parse(once.nextRunAt!) + 60_000)!; s.finish(once.id, claimed);
    expect(() => s.update(once.id, "u", { enabled: true })).toThrow(/future time/);
  });
});
