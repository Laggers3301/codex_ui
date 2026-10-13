import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTaskStore } from "./scheduledTasks.js";
import { manageScheduledTask } from "./scheduledTaskMcp.js";

const rule = { kind: "interval" as const, intervalMinutes: 15, timezone: "Asia/Shanghai" };
const owner = (id: string) => id === "a" || id === "a2" ? { userId: "alice", projectId: "p", rootPath: "/tmp" } : id === "b" ? { userId: "bob", projectId: "q", rootPath: "/tmp" } : null;
const store = {
  getThreadOwner: owner,
  getProject: (id: string, user: string) => (id === "p" && user === "alice") || (id === "q" && user === "bob") ? { id, name: id, rootPath: "/tmp" } : null,
  userCanAccessThread: (id: string, user: string, project?: string) => owner(id)?.userId === user && (!project || owner(id)?.projectId === project)
} as any;
describe("scheduled task agent tools", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it("creates, discovers across own conversations, updates, pauses, resumes, deletes and persists", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-tools-"));
    try {
      const tasks = new ScheduledTaskStore(path.join(temp, "tasks.json"));
      const alice = { userId: "alice", projectId: "p", threadId: "a" };
      const other = { ...alice, threadId: "a2" };
      const run = (scope: typeof alice, input: unknown) => manageScheduledTask(tasks, store, scope, input) as any;
      const created = run(alice, { action: "create", title: "检查项目", prompt: "检查项目状态并汇报", schedule: rule });
      expect(created.data.threadId).toBe("a");
      expect(created.data.enabled).toBe(true);
      const id = created.data.id;
      expect(run(other, { action: "list" }).data).toHaveLength(0);
      expect(run(other, { action: "list", scope: "user" }).data).toHaveLength(1);
      expect(run(other, { action: "update", taskId: id, title: "新标题" }).data).toMatchObject({ title: "新标题", prompt: "检查项目状态并汇报", schedule: rule });
      expect(run(other, { action: "pause", taskId: id }).data).toMatchObject({ enabled: false, nextRunAt: null });
      expect(run(other, { action: "resume", taskId: id }).data.enabled).toBe(true);
      const restored = new ScheduledTaskStore(path.join(temp, "tasks.json"));
      expect(restored.listForUser("alice")[0].title).toBe("新标题");
      expect(() => run(other, { action: "delete", taskId: id })).toThrow(/明确/);
      expect(run(other, { action: "delete", taskId: id, confirm: true }).ok).toBe(true);
      expect(run(alice, { action: "list", scope: "user" }).data).toHaveLength(0);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  it("rejects cross-user targets, wrong threads, bad schedules, unknown fields and uncertain run edits", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-tools-"));
    try {
      const tasks = new ScheduledTaskStore(path.join(temp, "tasks.json"));
      const a = { userId: "alice", projectId: "p", threadId: "a" };
      const b = { userId: "bob", projectId: "q", threadId: "b" };
      const bob = (manageScheduledTask(tasks, store, b, { action: "create", prompt: "私有", schedule: rule }) as any).data;
      expect(() => manageScheduledTask(tasks, store, a, { action: "get", taskId: bob.id })).toThrow(/不属于/);
      expect(() => manageScheduledTask(tasks, store, a, { action: "create", threadId: "b", prompt: "越权", schedule: rule })).toThrow(/不属于/);
      expect(() => manageScheduledTask(tasks, store, a, { action: "list", userId: "bob" })).toThrow();
      expect(() => manageScheduledTask(tasks, store, a, { action: "create", prompt: "太频繁", schedule: { ...rule, intervalMinutes: 1 } })).toThrow();
      expect(() => manageScheduledTask(tasks, store, a, { action: "create", prompt: "错时区", schedule: { ...rule, timezone: "wrong" } })).toThrow();
      const task = (manageScheduledTask(tasks, store, a, { action: "create", prompt: "任务", schedule: rule }) as any).data;
      expect(() => manageScheduledTask(tasks, store, a, { action: "pause", taskId: task.id, threadId: "a2" })).toThrow(/不匹配/);
      tasks.claim(task.id, Date.parse(task.nextRunAt));
      expect(() => manageScheduledTask(tasks, store, a, { action: "pause", taskId: task.id })).toThrow(/dispatch/);
      expect(manageScheduledTask(tasks, store, a, { action: "list", scope: "user" })).toMatchObject({ data: [{ id: task.id }], defaultTimezone: "Asia/Shanghai" });
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
  it("exposes MCP discovery with signed conversation credentials and rejects forged credentials", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-mcp-"));
    vi.stubEnv("CODEX_WEB_DATA_DIR", temp); vi.resetModules();
    const { registerBrowserRoutes, mintBrowserMcpConfig } = await import("./browserRoutes.js");
    const { registerScheduledTaskMcp } = await import("./scheduledTaskMcp.js");
    const app = Fastify();
    try {
      registerBrowserRoutes(app, store, {} as any);
      registerScheduledTaskMcp(app, store, new ScheduledTaskStore(path.join(temp, "tasks.json")));
      const cfg = mintBrowserMcpConfig("alice", "p", "a").config as any;
      const headers = cfg["mcp_servers.codex_schedules"].http_headers;
      const invoke = (method: string, params?: unknown, custom = headers) => app.inject({ method: "POST", url: "/api/schedules/mcp", headers: custom, payload: { jsonrpc: "2.0", id: 1, method, params } });
      expect((await invoke("initialize", { protocolVersion: "2025-03-26" })).json().result.serverInfo.name).toBe("codex-schedules");
      expect((await invoke("tools/list")).json().result.tools[0].name).toBe("scheduled_tasks");
      const created = (await invoke("tools/call", { name: "scheduled_tasks", arguments: { action: "create", prompt: "测试", schedule: rule, enabled: false } })).json();
      expect(created.result.structuredContent.data.enabled).toBe(false);
      expect((await invoke("tools/list", {}, { "x-codex-browser-token": "forged" })).statusCode).toBe(401);
      const error = (await invoke("tools/call", { name: "scheduled_tasks", arguments: { action: "create", threadId: "b", prompt: "越权", schedule: rule } })).json();
      expect(error.result.isError).toBe(true);
    } finally { await app.close(); fs.rmSync(temp, { recursive: true, force: true }); }
  });
});
