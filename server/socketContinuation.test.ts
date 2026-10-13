import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { attachSocketServer } from "./socket.js";

class FakeBridge extends EventEmitter {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  onResume?: () => void;
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/queue/list") return { data: [] };
    if (method === "thread/resume") this.onResume?.();
    if (method === "turn/start") return { turn: { id: `recovery-${this.calls.filter((call) => call.method === method).length}` } };
    return {};
  }
  getPendingServerRequests() { return []; }
}

async function withSocket(run: (bridge: FakeBridge) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socket-continuation-"));
  const store = new ProjectStore(path.join(directory, "store.sqlite"));
  const project = store.createProject({ name: "test", rootPath: directory });
  store.registerThreadOwner({ threadId: "thread", userId: "admin", projectId: project.id, rootPath: directory });
  const bridge = new FakeBridge();
  const server = http.createServer();
  const wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(bridge); }
  finally {
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function start(bridge: FakeBridge, turnId = "turn") {
  bridge.emit("notification", { method: "turn/started", params: { threadId: "thread", turn: { id: turnId } } });
}
function answer(bridge: FakeBridge, text: string, turnId = "turn", itemId = "answer") {
  bridge.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "thread", turnId, itemId, delta: text } });
}
function tool(bridge: FakeBridge, turnId = "turn") {
  bridge.emit("notification", { method: "item/commandExecution/completed", params: { threadId: "thread", turnId, item: { id: `tool-${turnId}`, type: "commandExecution", command: "test", output: "done" } } });
}
function complete(bridge: FakeBridge, status = "completed", turnId = "turn", runtimeExited = false) {
  bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread", turn: { id: turnId, status }, runtimeExited } });
}

describe("planning-only continuation socket guard", () => {
  it.each(["interrupted", "failed", "unknown"])("does not restart a %s turn", async (status) => {
    await withSocket(async (bridge) => {
      start(bridge);
      answer(bridge, "我现在去跑测试，确认构建结果。");
      complete(bridge, status);
      await vi.waitFor(() => expect(bridge.calls.some((call) => call.method === "thread/queue/list")).toBe(true));
      expect(bridge.calls.some((call) => call.method === "turn/start")).toBe(false);
    });
  });

  it.each([
    "我的判断是：下一步应集中解决真实数据验收，而不是继续扩模型库。\n\n建议按下面顺序推进。\n\n你现在最值得承担的工作，是把 C294 做成可定位、可复测的案例，并验证一个局部 PP 修正是否真的降低独立标注误差。",
    "当前后端会在模型只说‘我现在去测试’时自动续跑。服务现在不用再重启。",
    "任务已经完成，测试结果如下。"
  ])("does not continue a delivered answer: %s", async (text) => {
    await withSocket(async (bridge) => {
      start(bridge);
      answer(bridge, text);
      complete(bridge);
      await vi.waitFor(() => expect(bridge.calls.some((call) => call.method === "thread/queue/list")).toBe(true));
      expect(bridge.calls.some((call) => call.method === "turn/start")).toBe(false);
    });
  });

  it("retains recovery for a real immediate promise even after earlier tools", async () => {
    await withSocket(async (bridge) => {
      start(bridge);
      tool(bridge);
      answer(bridge, "我现在去跑测试，确认构建结果。");
      complete(bridge);
      await vi.waitFor(() => expect(bridge.calls.filter((call) => call.method === "turn/start")).toHaveLength(1));
      const recovery = bridge.calls.find((call) => call.method === "turn/start")!;
      expect(JSON.stringify(recovery.params.input)).toContain("<codex_internal_continuation_recovery>");
      expect(bridge.calls.some((call) => call.method === "thread/queue/list")).toBe(false);
      start(bridge, "recovery-1");
      answer(bridge, "已修复，任务已经完成。", "recovery-1");
      complete(bridge, "completed", "recovery-1");
      await vi.waitFor(() => expect(bridge.calls.some((call) => call.method === "thread/queue/list")).toBe(true));
      expect(bridge.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    });
  });

  it("does not recover when a tool already followed the promise or the runtime exited", async () => {
    for (const runtimeExited of [false, true]) await withSocket(async (bridge) => {
      start(bridge);
      answer(bridge, "我现在去跑测试。");
      if (!runtimeExited) tool(bridge);
      complete(bridge, "completed", "turn", runtimeExited);
      await vi.waitFor(() => expect(bridge.calls.some((call) => call.method === "thread/queue/list")).toBe(true));
      expect(bridge.calls.some((call) => call.method === "turn/start")).toBe(false);
    });
  });

  it("does not race a newer user turn during resume", async () => {
    await withSocket(async (bridge) => {
      bridge.onResume = () => start(bridge, "new-user-turn");
      start(bridge);
      answer(bridge, "我现在去跑测试。");
      complete(bridge);
      await vi.waitFor(() => expect(bridge.calls.some((call) => call.method === "thread/resume")).toBe(true));
      expect(bridge.calls.some((call) => call.method === "turn/start")).toBe(false);
    });
  });
});
