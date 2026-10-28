import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ProjectStore } from "./db.js";
import { SessionTaskRunner } from "./sessionTaskRunner.js";

vi.mock("./browserRoutes.js", () => ({ browserMcpForThread: (threadId: string) => ({ testMcpScope: threadId }) }));
vi.mock("./hookTrust.js", () => ({ scopedHookTrustConfig: async () => ({}) }));
vi.mock("./threadContext.js", () => ({ defaultThreadContextConfig: () => ({}), readThreadContextUsage: async () => ({}),
  threadContextConfigOverrides: () => ({}), threadTurnContextConfigOverrides: () => ({}), contextWindowMeasuredForConfig: () => null }));

async function fixture(run: (f: any) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-native-tasks-")), file = path.join(root, "isolated.sqlite");
  const store = new ProjectStore(file), project = store.createProject({ name: "native task", rootPath: root });
  store.ensureUser("other", "other");
  for (const threadId of ["a", "b", "c"]) store.registerThreadOwner({ threadId, userId: "admin", projectId: project.id, rootPath: root });
  const foreignProject = store.createProject({ name: "private", userId: "other", rootPath: root });
  store.registerThreadOwner({ threadId: "foreign", userId: "other", projectId: foreignProject.id, rootPath: root });
  store.setThreadExecutionSettings("a", "admin", "danger-full-access", "never");
  store.setThreadExecutionSettings("b", "admin", "read-only", "on-request");
  const registry = { activeTurnsByThread: new Map<string, string>(), startingThreads: new Set<string>() };
  class Bridge extends EventEmitter {
    calls: Array<{ method: string; params: any }> = [];
    turns = new Map<string, any[]>();
    active = new Map<string, string>();
    pending: any[] = [];
    queued: any[] = [];
    ambiguousStart = false;
    callbackAmbiguous = false;
    getPendingServerRequests() { return this.pending; }
    async request(method: string, params: any = {}) {
      this.calls.push({ method, params }); const threadId = params.threadId;
      if (method === "thread/loaded/list") return { data: [] };
      if (method === "thread/read") return { thread: { id: threadId, status: this.active.has(threadId) ? "active" : "idle" } };
      if (method === "thread/queue/list") return { data: this.queued };
      if (method === "thread/turns/list") return { data: [...(this.turns.get(threadId) ?? [])].reverse().slice(0, params.limit) };
      if (method === "thread/items/list") return { data: ((this.turns.get(threadId) ?? []).find(turn => turn.id === params.turnId)?.items ?? []).map((item: unknown) => ({ turnId: params.turnId, item })) };
      if (method === "turn/start") {
        if (this.ambiguousStart && !params.toolOutput) throw new Error("RPC response timeout: receiver state unknown");
        if (this.callbackAmbiguous && params.toolOutput) throw new Error("callback response timeout");
        if (params.toolOutput && this.active.has(threadId)) return { turn: { id: this.active.get(threadId) } };
        const turn = { id: randomUUID(), status: "inProgress", items: [] };
        this.turns.set(threadId, [...(this.turns.get(threadId) ?? []), turn]);this.active.set(threadId, turn.id);
        registry.activeTurnsByThread.set(threadId, turn.id);
        this.emit("notification", { method: "turn/started", params: { threadId, turn } }); return { turn };
      }
      if (method === "turn/interrupt") { this.complete(threadId, "interrupted"); return {}; }
      return {};
    }
    complete(threadId: string, status = "completed", text = "被委派会话的最终结果") {
      const turn = this.turns.get(threadId)!.at(-1)!;turn.status = status;
      turn.items = [{ type: "agentMessage", phase: "final_answer", text }];
      if (status === "failed") turn.error = { message: "模型服务明确失败的原因" };
      this.active.delete(threadId);registry.activeTurnsByThread.delete(threadId);
      store.saveTimelineItem(threadId, turn.id, { id: "answer-" + turn.id, type: "agentMessage", text });
      this.emit("notification", { method: "turn/completed", params: { threadId, turn } });
    }
  }
  const bridge = new Bridge(), quota = vi.fn(async () => {});
  let runner: SessionTaskRunner | undefined;
  const attach = () => runner = new SessionTaskRunner(bridge as any, store, { registry, beforeStart: quota, retryPending: () => false,
    accepted: (threadId, _requestId, result: any) => { if (bridge.active.has(threadId)) registry.activeTurnsByThread.set(threadId, result.turn.id); } });
  let sequence = 0;
  const send = (source = "a", target = "b", returnToSource = true, requestId = `request-${++sequence}`) => store.communication.tasks.send("admin", source,
    { operation: "task.send", targetThreadId: target, message: "请核对文件并汇报", returnToSource, requestId });
  const current = (id: string) => store.communication.tasks.get("admin", "a", id);
  try { await run({ store, project, root, file, bridge, registry, quota, attach, send, current, close: () => { runner?.close(); runner = undefined; } }); }
  finally { runner?.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

describe("native cross-session task execution", () => {
  it("executes an existing target with its own policy and automatically delivers native toolOutput to the source", () => fixture(async f => {
    f.attach();const task = f.send();
    await vi.waitFor(() => expect(f.current(task.id).state).toBe("running"));
    const start = f.bridge.calls.find((call: any) => call.method === "turn/start").params;
    expect(start).toMatchObject({ threadId: "b", cwd: f.root, permissions: ":read-only", approvalPolicy: "on-request" });
    expect(start.input[0].text).toContain(task.id);
    f.bridge.complete("b");
    await vi.waitFor(() => expect(f.current(task.id).callbackState).toBe("delivered"));
    const callback = f.bridge.calls.find((call: any) => call.method === "turn/start" && call.params.toolOutput).params;
    expect(callback).toMatchObject({ threadId: "a", input: [], permissions: ":danger-full-access", toolOutput: { name: "session_communication", retain: true } });
    expect(JSON.parse(callback.toolOutput.output)).toMatchObject({ taskId: task.id, status: "succeeded", result: "被委派会话的最终结果" });
    expect(f.current(task.id).result).toBe("被委派会话的最终结果");
  }));
  it("queues while a target is busy and never interrupts its unrelated current turn", () => fixture(async f => {
    f.registry.activeTurnsByThread.set("b", "unrelated-turn");f.attach();const task = f.send("a", "b", false);
    await new Promise(resolve => setTimeout(resolve, 35));expect(f.current(task.id).state).toBe("queued");
    expect(f.bridge.calls.filter((call: any) => /turn\/(start|interrupt)/.test(call.method))).toEqual([]);
    f.registry.activeTurnsByThread.delete("b");f.store.communication.tasks.wake();
    await vi.waitFor(() => expect(f.current(task.id).state).toBe("running"));
    f.bridge.complete("b");await vi.waitFor(() => expect(f.current(task.id).state).toBe("succeeded"));
    expect(f.current(task.id).callbackState).toBe("none");
  }));
  it("injects a callback as tool output into an active source without steering or changing its model and permissions", () => fixture(async f => {
    f.registry.activeTurnsByThread.set("a", "original-source-turn");f.bridge.active.set("a", "original-source-turn");f.attach();const task = f.send();
    await vi.waitFor(() => expect(f.current(task.id).state).toBe("running"));f.bridge.complete("b");
    await vi.waitFor(() => expect(f.current(task.id).callbackState).toBe("delivered"));
    const params = f.bridge.calls.find((call: any) => call.params.toolOutput).params;
    expect(params.input).toEqual([]);expect(params.model).toBeUndefined();expect(params.permissions).toBeUndefined();
    expect(f.bridge.active.get("a")).toBe("original-source-turn");
    expect(f.bridge.calls.some((call: any) => call.method === "turn/steer")).toBe(false);
  }));
  it("rejects foreign or archived targets and cycles, deduplicates dispatch, and bounds active work", () => fixture(async f => {
    expect(() => f.send("a", "foreign")).toThrow("不属于");expect(() => f.send("a", "a")).toThrow("另一个");
    const first = f.send("a", "b", false, "stable-request");expect(f.send("a", "b", false, "stable-request").id).toBe(first.id);
    expect(() => f.store.communication.tasks.send("admin", "a", { operation: "task.send", targetThreadId: "b", message: "changed", requestId: "stable-request", returnToSource: false })).toThrow("其他内容");
    expect(() => f.send("b", "a")).toThrow("循环");
    for (let i = 0; i < 9; i++) f.send("a", "b", false);
    expect(() => f.send("a", "b", false)).toThrow("上限");
    expect(f.store.communication.tasks.targets("other", "foreign").some((target: any) => target.threadId === "a")).toBe(false);
    expect(() => f.store.communication.tasks.get("other", "foreign", first.id)).toThrow("无权");
    f.store.setThreadLocallyArchived("c", "admin", f.project.id, true);expect(() => f.send("a", "c")).toThrow("归档");
  }));
  it("does not replay an ambiguous submission, including after restarting the dispatcher", () => fixture(async f => {
    f.bridge.ambiguousStart = true;f.attach();const task = f.send("a", "b", false);
    await vi.waitFor(() => expect(f.current(task.id).state).toBe("unknown"));f.close();f.attach();
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(f.bridge.calls.filter((call: any) => call.method === "turn/start")).toHaveLength(1);
    expect(f.current(task.id).error).toContain("不自动重发");
  }));
  it("preserves native delegation lineage and stops automatic task chains after four levels", () => fixture(async f => {
    for (const threadId of ["d", "e", "f"]) f.store.registerThreadOwner({ threadId, userId: "admin", projectId: f.project.id, rootPath: f.root });
    f.registry.activeTurnsByThread.set("a", "root-turn");f.attach();
    let parent: any;
    for (const [source, target] of [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"]]) {
      const task = f.send(source, target, false);
      await vi.waitFor(() => expect(f.store.communication.tasks.getInternal(task.id).state).toBe("running"));
      const actual = f.store.communication.tasks.getInternal(task.id);
      expect(actual.rootTurnId).toBe("root-turn");expect(actual.parentTaskId).toBe(parent?.id ?? null);
      parent = actual;
    }
    expect(() => f.send("e", "f", false)).toThrow("4 层");
    const child = f.bridge.calls.find((call: any) => call.method === "turn/start" && call.params.threadId === "c").params;
    expect(child).toMatchObject({ parentTurnId: f.registry.activeTurnsByThread.get("b"), rootTurnId: "root-turn" });
  }));
  it("recovers a completed known turn using bounded native pages and never resubmits it", () => fixture(async f => {
    const task = f.send("a", "b", false);f.store.communication.tasks.update(task.id, { state: "running", targetTurnId: "known-turn" });
    f.bridge.turns.set("b", [{ id: "known-turn", status: "completed", items: [{ type: "agentMessage", text: "重启前已完成" }] }]);
    f.attach();await vi.waitFor(() => expect(f.current(task.id).state).toBe("succeeded"));
    expect(f.current(task.id).result).toBe("重启前已完成");expect(f.bridge.calls.some((call: any) => call.method === "turn/start")).toBe(false);
    expect(f.bridge.calls.find((call: any) => call.method === "thread/items/list").params).toMatchObject({ turnId: "known-turn", limit: 1 });
  }));
  it("recovers a dispatch with a confirmed native turn id and informs the source about an unconfirmed dispatch", () => fixture(async f => {
    const known = f.send("a", "b", false);
    f.store.communication.tasks.update(known.id, { state: "dispatching", targetTurnId: "accepted-before-restart" });
    f.bridge.turns.set("b", [{ id: "accepted-before-restart", status: "completed", items: [{ type: "agentMessage", text: "无需重复执行" }] }]);
    f.attach();await vi.waitFor(() => expect(f.current(known.id).state).toBe("succeeded"));
    expect(f.bridge.calls.some((call: any) => call.method === "turn/start")).toBe(false);
    f.bridge.ambiguousStart = true;const unknown = f.send();
    await vi.waitFor(() => expect(f.current(unknown.id).callbackState).toBe("delivered"));
    expect(f.current(unknown.id).state).toBe("unknown");
    const output = f.bridge.calls.find((call: any) => call.params.toolOutput).params.toolOutput.output;
    expect(JSON.parse(output)).toMatchObject({ taskId: unknown.id, status: "unknown" });
  }));
  it("preserves failure details, cancels only the matching running task, and retains results on callback failure", () => fixture(async f => {
    f.attach();const canceled = f.send("a", "b", false);
    await vi.waitFor(() => expect(f.current(canceled.id).state).toBe("running"));
    f.store.communication.tasks.cancel("admin", "a", { operation: "task.cancel", id: canceled.id, requestId: "cancel-task" });
    await vi.waitFor(() => expect(f.current(canceled.id).state).toBe("canceled"));
    expect(f.bridge.calls.find((call: any) => call.method === "turn/interrupt").params.turnId).toBe(f.current(canceled.id).targetTurnId);
    f.bridge.callbackAmbiguous = true;const failed = f.send();
    await vi.waitFor(() => expect(f.current(failed.id).state).toBe("running"));f.bridge.complete("b", "failed");
    await vi.waitFor(() => expect(f.current(failed.id).callbackState).toBe("unknown"));
    expect(f.current(failed.id).error).toContain("模型服务明确失败的原因");
    expect(f.current(failed.id).callbackError).toContain("不重复唤醒");
  }));
});
