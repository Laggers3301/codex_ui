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
  async request(method: string, params: any = {}) {
    this.calls.push(method); this.parameters.push({ method, params });
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    if (method === "thread/queue/list") return { data: [] };
    if (method === "turn/start" && this.rejectNextStart) { this.rejectNextStart = false; throw { message: "Selected model is at capacity.", codexErrorInfo: "server_overloaded" }; }
    if (method === "turn/start") return { turn: { id: "turn-" + this.parameters.filter(row => row.method === method).length } };
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
