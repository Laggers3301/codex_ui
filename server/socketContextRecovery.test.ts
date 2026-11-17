import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { createSessionCookie } from "./auth.js";
import { attachSocketServer } from "./socket.js";

const source = vi.hoisted(() => ({ file: "", completed: 0 }));
vi.mock("./threadFallback.js", async original => ({ ...await original<typeof import("./threadFallback.js")>(), findThreadJsonlPathById: async () => source.file }));
vi.mock("./contextRecoverySource.js", async original => {
  const actual = await original<typeof import("./contextRecoverySource.js")>();
  return { ...actual, readContextRecoverySource: async (file: string) => {
    try { return await actual.readContextRecoverySource(file); }
    finally { source.completed++; }
  } };
});

async function fixture(run: (f: { calls: Array<{ method: string; params: any }>; emit: (method: string, params: any) => void; store: ProjectStore }) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socket-context-"));
  source.file = path.join(dir, "rollout.jsonl");
  source.completed = 0;
  fs.writeFileSync(source.file, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "继续修复 BundleSDF 接口，保留动作，科研计算仅 H20。" } }) + "\n");
  const store = new ProjectStore(path.join(dir, "store.sqlite"));
  const project = store.createProject({ name: "fixture", rootPath: dir });
  store.registerThreadOwner({ threadId: "thread", userId: "admin", projectId: project.id, rootPath: dir });
  const calls: Array<{ method: string; params: any }> = [];
  const bridge = Object.assign(new EventEmitter(), {
    getPendingServerRequests: () => [],
    request: async (method: string, params: any = {}) => {
      calls.push({ method, params });
      if (method === "turn/start") return { turn: { id: `turn-${calls.filter(c => c.method === method).length}` } };
      return { data: [] };
    }
  });
  const server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws`, { headers: { cookie: createSessionCookie("admin") } });
  const messages: any[] = []; ws.on("message", raw => messages.push(JSON.parse(String(raw))));
  const emit = (method: string, params: any) => bridge.emit("notification", { method, params: { threadId: "thread", turnId: "turn-1", ...params } });
  try {
    await vi.waitFor(() => expect(messages.some(m => m.type === "hello")).toBe(true));
    ws.send(JSON.stringify({ type: "turn.start", requestId: "start", threadId: "thread", projectId: project.id, prompt: "continue", sandbox: "read-only", approvalPolicy: "on-request" }));
    await vi.waitFor(() => expect(messages.find(m => m.requestId === "start")?.ok).toBe(true));
    emit("turn/started", { turn: { id: "turn-1" } });
    await run({ calls, emit, store });
  } finally {
    ws.terminate(); wss.clients.forEach(c => c.terminate());
    await new Promise<void>(r => wss.close(() => server.close(() => r())));
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
}

it("rehydrates twice in the same native turn, once per compaction, with concrete task excerpts", async () => {
  await fixture(async ({ calls, emit }) => {
    const compact = (id: string, method = "item/completed") => emit(method, { item: { id, type: "contextCompaction" } });
    compact("c1", "item/started"); compact("c1");
    await vi.waitFor(() => expect(calls.filter(c => c.method === "turn/steer")).toHaveLength(1));
    compact("c2", "item/started"); compact("c2"); compact("c1");
    await vi.waitFor(() => expect(calls.filter(c => c.method === "turn/steer")).toHaveLength(2));
    for (const c of calls.filter(c => c.method === "turn/steer")) {
      expect(c.params.expectedTurnId).toBe("turn-1");
      expect(JSON.stringify(c.params.input)).toContain("BundleSDF");
      expect(JSON.stringify(c.params.input)).toContain(source.file);
    }
    emit("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  });
});

it.each(["completed", "interrupted"])("Chinese lost-task fallback respects %s and saved execution permissions", async status => {
  await fixture(async ({ calls, emit }) => {
    emit("item/completed", { item: { id: "c1", type: "contextCompaction" } });
    await vi.waitFor(() => expect(calls.filter(c => c.method === "turn/steer")).toHaveLength(1));
    emit("item/agentMessage/delta", { itemId: "lost", delta: "目前可见上下文只有工作区约定，缺少此前的具体任务。请补一句目标。" });
    emit("turn/completed", { turn: { id: "turn-1", status } });
    await vi.waitFor(() => expect(calls.some(c => c.method === (status === "completed" ? "thread/resume" : "thread/queue/list"))).toBe(true));
    if (status === "completed") {
      await vi.waitFor(() => expect(calls.filter(c => c.method === "turn/start")).toHaveLength(2));
      const recovery = calls.filter(c => c.method === "turn/start").at(-1)!;
      expect(recovery.params.approvalPolicy).toBe("on-request");
      expect(recovery.params.sandboxPolicy.type).toBe("readOnly");
      expect(JSON.stringify(recovery.params.input)).toContain("BundleSDF");
      emit("turn/completed", { turn: { id: "turn-2", status: "completed" } });
    } else expect(calls.filter(c => c.method === "turn/start")).toHaveLength(1);
  });
});

it("does not steer into a newer user turn while source extraction is pending", async () => {
  await fixture(async ({ calls, emit }) => {
    emit("item/completed", { item: { id: "c1", type: "contextCompaction" } });
    emit("turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
    emit("turn/started", { turnId: "new-user", turn: { id: "new-user" } });
    await vi.waitFor(() => expect(source.completed).toBe(1));
    expect(calls.filter(c => c.method === "turn/steer")).toHaveLength(0);
    expect(calls.filter(c => c.method === "turn/start")).toHaveLength(1);
    emit("turn/completed", { turnId: "new-user", turn: { id: "new-user", status: "completed" } });
  });
});
