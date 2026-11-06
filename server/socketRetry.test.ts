import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createSessionCookie } from "./auth.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { attachSocketServer } from "./socket.js";

type Message = { type: string; requestId?: string; ok?: boolean; data?: any };
class FakeBridge extends EventEmitter {
  pending: Array<{ id: number; method: string; params: unknown; receivedAt: string }> = [];
  responses: Array<{ id: number | string; result: unknown }> = [];
  calls: string[] = [];
  getPendingServerRequests() { return this.pending; }
  respondToServerRequest(id: number | string, result: unknown) {
    this.responses.push({ id, result });
    this.pending = this.pending.filter(request => request.id !== id);
  }
  parameters: Array<{ method: string; params: any }> = [];
  rejectNextStart = false;
  readStatus = "idle";
  startHook?: (turnId: string) => Promise<unknown>;
  async request(method: string, params: any = {}) {
    this.calls.push(method); this.parameters.push({ method, params });
    if (method === "thread/read") return { thread: { status: { type: this.readStatus } } };
    if (method === "thread/queue/list") return { data: [] };
    if (method === "turn/start" && this.rejectNextStart) { this.rejectNextStart = false; throw { message: "Selected model is at capacity.", codexErrorInfo: "server_overloaded" }; }
    if (method === "turn/start") {
      const turnId = "turn-" + this.parameters.filter(row => row.method === method).length;
      return this.startHook ? this.startHook(turnId) : { turn: { id: turnId } };
    }
    return {};
  }
}

async function client(port: number, user: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: createSessionCookie(user) } });
  const messages: Message[] = [];
  socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
  const wait = (predicate: (message: Message) => boolean): Promise<Message> => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("Socket message timed out")); }, 2_000);
      const receive = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString());
        if (!predicate(message)) return;
        clearTimeout(timer); socket.off("message", receive); resolve(message);
      };
      socket.on("message", receive);
    });
  };
  await wait(message => message.type === "hello");
  return { socket, messages, wait, send: (message: unknown) => socket.send(JSON.stringify(message)) };
}

describe("socket overload recovery", () => {
  it("keeps checking an active native actor without interrupting or duplicating it, then recovers when it is idle", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "socket-retry-preflight-"));
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const project = store.createProject({ name: "test", rootPath: temporary });
    store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: temporary });
    const bridge = new FakeBridge(), server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const sockets: WebSocket[] = [];
    const due = () => { const state = store.getTurnRecoveryState("thread-a")!; state.job!.nextRetryAt = Date.now() - 1; store.setTurnRecoveryState(state); };
    try {
      const first = await client((server.address() as { port: number }).port, "admin"); sockets.push(first.socket);
      first.send({ type: "turn.start", requestId: "preflight", projectId: project.id, threadId: "thread-a", prompt: "fixture" });
      expect((await first.wait(message => message.requestId === "preflight")).ok).toBe(true);
      bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-1", status: "failed", error: { codexErrorInfo: "ResponseStreamDisconnected" } } } });
      bridge.readStatus = "active"; due();
      await vi.waitFor(() => expect(bridge.calls).toContain("thread/read"), { timeout: 4_000 });
      await vi.waitFor(() => expect(store.getTurnRecoveryState("thread-a")?.job).toMatchObject({ status: "waiting", attempts: 0 }));
      expect(bridge.calls.filter(method => method === "turn/start")).toHaveLength(1);
      expect(bridge.calls).not.toContain("turn/interrupt");
      bridge.readStatus = "idle"; due();
      await vi.waitFor(() => expect(bridge.calls.filter(method => method === "turn/start")).toHaveLength(2), { timeout: 4_000 });
    } finally {
      sockets.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); store.close(); fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 12_000);

  it("automatically continues a terminal disconnected stream once with the browser offline, without touching another task", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "socket-auto-retry-"));
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const project = store.createProject({ name: "test", rootPath: temporary, defaultModel: "gpt-6.1-sol" });
    for (const threadId of ["thread-a", "thread-b"]) store.registerThreadOwner({ threadId, userId: "admin", projectId: project.id, rootPath: temporary });
    const bridge = new FakeBridge(), server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port, sockets: WebSocket[] = [];
    const emit = (method: string, params: Record<string, unknown>) => bridge.emit("notification", { method, params });
    try {
      const first = await client(port, "admin"); sockets.push(first.socket);
      first.send({ type: "turn.start", requestId: "once", projectId: project.id, threadId: "thread-a", prompt: "original must only be sent once" });
      expect((await first.wait(message => message.requestId === "once")).ok).toBe(true);
      emit("turn/started", { threadId: "thread-a", turn: { id: "turn-1" } });
      emit("turn/started", { threadId: "thread-b", turn: { id: "unrelated-turn" } });
      emit("error", { threadId: "thread-a", turnId: "turn-1", willRetry: true, error: { codexErrorInfo: "ResponseStreamDisconnected" } });
      expect(store.getTurnRecoveryState("thread-a")?.job).toBeNull();
      expect(bridge.calls.filter(method => method === "turn/start")).toHaveLength(1);
      const failure = { threadId: "thread-a", turn: { id: "turn-1", status: "failed", error: { message: "连接中断", codexErrorInfo: { responseStreamConnectionFailed: {} } } } };
      emit("turn/completed", failure);
      const pending = await first.wait(message => message.type === "turn.recovery" && message.data?.job?.status === "waiting");
      expect(pending.data.error.code).toBe("stream_disconnected");
      expect(pending.data.job.nextRetryAt - Date.now()).toBeGreaterThan(4_000);
      const job = store.getTurnRecoveryState("thread-a")?.job;
      emit("turn/completed", failure);
      expect(store.getTurnRecoveryState("thread-a")?.job?.id).toBe(job?.id);
      first.socket.terminate();
      // No retry button, new prompt, or page refresh: the backend timer alone
      // resumes the same task while every browser connection is closed.
      await vi.waitFor(() => expect(bridge.calls.filter(method => method === "turn/start")).toHaveLength(2), { timeout: 9_000 });
      const retry = bridge.parameters.filter(row => row.method === "turn/start")[1].params;
      expect(JSON.stringify(retry.input)).toContain("模型连接中断");
      expect(JSON.stringify(retry.input)).not.toContain("original must only be sent once");
      expect(bridge.parameters.filter(row => row.method === "thread/resume").at(-1)?.params.excludeTurns).toBe(true);
      const restored = await client(port, "admin"); sockets.push(restored.socket);
      const hello = await restored.wait(message => message.type === "hello");
      expect(hello.data.turnRecoveries[0].job.status).toBe("running");
      expect(hello.data.liveState.activeTurns).toContainEqual(expect.objectContaining({ threadId: "thread-b", turnId: "unrelated-turn" }));
      emit("turn/completed", failure);
      expect(store.getTurnRecoveryState("thread-a")?.job?.status).toBe("running");
      emit("turn/completed", { threadId: "thread-a", turn: { id: "turn-2", status: "completed" } });
      await vi.waitFor(() => expect(store.getTurnRecoveryState("thread-a")?.job).toBeNull());
      expect(bridge.calls.filter(method => method === "turn/start")).toHaveLength(2);
      expect(bridge.calls).not.toContain("turn/interrupt");
      expect(bridge.parameters.filter(row => row.method === "turn/start").every(row => row.params.threadId === "thread-a")).toBe(true);
    } finally {
      sockets.forEach(socket => socket.terminate()); wss.clients.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); store.close(); fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 15_000);

  it("does not resurrect an already completed turn when the RPC reply arrives late", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "socket-late-reply-"));
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const project = store.createProject({ name: "test", rootPath: temporary });
    store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: temporary });
    const bridge = new FakeBridge(), server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const sockets: WebSocket[] = [];
    try {
      bridge.startHook = async turnId => {
        bridge.emit("notification", { method: "turn/started", params: { threadId: "thread-a", turn: { id: turnId } } });
        bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-a", turn: { id: turnId, status: "completed" } } });
        return { turn: { id: turnId } };
      };
      const first = await client((server.address() as { port: number }).port, "admin"); sockets.push(first.socket);
      first.send({ type: "turn.start", requestId: "quick", projectId: project.id, threadId: "thread-a", prompt: "quick fixture" });
      expect((await first.wait(message => message.requestId === "quick")).ok).toBe(true);
      const second = await client((server.address() as { port: number }).port, "admin"); sockets.push(second.socket);
      expect((await second.wait(message => message.type === "hello")).data.liveState.activeTurns).toEqual([]);
      expect(store.getTurnRecoveryState("thread-a")?.job).toBeNull();
    } finally {
      sockets.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); store.close(); fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("reconnects with error details, scopes controls to the owner, and resumes the same task once", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "socket-retry-"));
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const project = store.createProject({ name: "test", rootPath: temporary, defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "max" });
    store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: temporary });
    store.ensureUser("other", "other");
    const bridge = new FakeBridge(), server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port, sockets: WebSocket[] = [];
    try {
      const first = await client(port, "admin"); sockets.push(first.socket);
      first.send({ type: "turn.start", requestId: "original", projectId: project.id, threadId: "thread-a", prompt: "private original task", collaborationMode: "default" });
      expect((await first.wait(message => message.requestId === "original")).ok).toBe(true);
      bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-1", status: "failed", error: { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "server_overloaded" } } } });
      const pending = await first.wait(message => message.type === "turn.recovery" && message.data?.job?.status === "waiting");
      expect(pending.data.error.code).toBe("model_overloaded"); expect(pending.data.job.nextRetryAt - Date.now()).toBeGreaterThan(58_000);
      const restored = await client(port, "admin"); sockets.push(restored.socket);
      const hello = await restored.wait(message => message.type === "hello"); expect(hello.data.turnRecoveries[0].error.originalMessage).toContain("at capacity");
      expect(JSON.stringify(hello.data.turnRecoveries)).not.toContain("private original task");
      const foreign = await client(port, "other"); sockets.push(foreign.socket);
      expect((await foreign.wait(message => message.type === "hello")).data.turnRecoveries).toEqual([]);
      foreign.send({ type: "turn.retry.cancel", requestId: "foreign", threadId: "thread-a" }); expect((await foreign.wait(message => message.requestId === "foreign")).ok).toBe(false);
      restored.send({ type: "turn.retry.now", requestId: "now", threadId: "thread-a" }); expect((await restored.wait(message => message.requestId === "now")).ok).toBe(true);
      await vi.waitFor(() => expect(bridge.calls.filter(method => method === "turn/start")).toHaveLength(2));
      const retry = bridge.parameters.filter(row => row.method === "turn/start")[1].params;
      expect(retry.model).toBe("gpt-6.1-sol"); expect(retry.effort).toBe("max"); expect(retry.collaborationMode.mode).toBe("default");
      expect(JSON.stringify(retry.input)).toContain("<codex_internal_retry>"); expect(JSON.stringify(retry.input)).not.toContain("private original task");
      bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-2", status: "completed" } } });
      await vi.waitFor(() => expect(store.getTurnRecoveryState("thread-a")?.job).toBeNull());
      expect(bridge.calls.filter(method => method === "turn/start")).toHaveLength(2);
      bridge.rejectNextStart = true;
      first.send({ type: "turn.start", requestId: "rejected-start", projectId: project.id, threadId: "thread-a", prompt: "new task never accepted", collaborationMode: "default" });
      const queued = await first.wait(message => message.requestId === "rejected-start"); expect(queued.ok).toBe(true); expect(queued.data.queuedForRetry).toBe(true);
      first.send({ type: "turn.retry.now", requestId: "now-original", threadId: "thread-a" });
      await vi.waitFor(() => expect(bridge.calls.filter(method => method === "turn/start")).toHaveLength(4));
      const resumed = bridge.parameters.filter(row => row.method === "turn/start")[3].params;
      expect(JSON.stringify(resumed.input)).toContain("new task never accepted"); expect(JSON.stringify(resumed.input)).not.toContain("<codex_internal_retry>");
      await vi.waitFor(() => expect(store.getTurnRecoveryState("thread-a")?.job?.activeTurnId).toBe("turn-4"));
    } finally {
      vi.restoreAllMocks(); sockets.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); store.close(); fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
