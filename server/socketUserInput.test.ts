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
  async request(method: string) { this.calls.push(method); return {}; }
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

describe("native question answers over the socket", () => {
  it("keeps late questions on reconnect, routes all answers to the original tool, and rejects foreign or stale replies", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "socket-user-input-"));
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const project = store.createProject({ name: "test", rootPath: temporary });
    store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: temporary });
    store.ensureUser("other", "other");
    const bridge = new FakeBridge();
    const server = http.createServer();
    const wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const sockets: WebSocket[] = [];
    try {
      const first = await client(port, "admin"); sockets.push(first.socket);
      bridge.emit("notification", { method: "turn/started", accountId: "account-a", params: { threadId: "thread-a", turnId: "turn-a", turn: { id: "turn-a" } } });
      const params = { threadId: "thread-a", turnId: "turn-a", itemId: "call-q", isBlocking: true, questions: [
        { id: "robot", header: "机器人", question: "选择范围", options: [{ label: "A", description: "A" }] },
        { id: "camera", header: "相机", question: "选择范围", options: null }
      ] };
      const pending = { id: 17, method: "item/tool/requestUserInput", params, receivedAt: new Date().toISOString() };
      bridge.pending.push(pending);
      bridge.emit("serverRequest", { ...pending, accountId: "account-a" });
      expect((await first.wait(message => message.type === "turn.progress" && message.data?.state === "waiting_user_input")).data.threadId).toBe("thread-a");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60_000);
      const restored = await client(port, "admin"); sockets.push(restored.socket);
      expect((await restored.wait(message => message.type === "hello")).data.pendingServerRequests).toEqual([pending]);
      const foreign = await client(port, "other"); sockets.push(foreign.socket);
      expect((await foreign.wait(message => message.type === "hello")).data.pendingServerRequests).toEqual([]);
      const result = { answers: { robot: { answers: ["A"] }, camera: { answers: ["自定义\n第二行：内容"] } } };
      foreign.send({ type: "userInput.respond", requestId: "foreign", codexRequestId: 17, threadId: "thread-a", result });
      expect((await foreign.wait(message => message.requestId === "foreign")).ok).toBe(false);
      restored.send({ type: "userInput.respond", requestId: "partial", codexRequestId: 17, threadId: "thread-a", result: { answers: { robot: result.answers.robot } } });
      expect((await restored.wait(message => message.requestId === "partial")).ok).toBe(false);
      expect(bridge.responses).toEqual([]);
      restored.send({ type: "userInput.respond", requestId: "answer", codexRequestId: 17, threadId: "thread-a", result });
      expect((await restored.wait(message => message.requestId === "answer")).ok).toBe(true);
      expect(bridge.responses).toEqual([{ id: 17, result }]);
      expect(bridge.calls).toEqual([]);
      await first.wait(message => message.type === "codex.notification" && message.data?.method === "serverRequest/resolved");
      await first.wait(message => message.type === "turn.progress" && message.data?.state === "active");
      restored.send({ type: "userInput.respond", requestId: "duplicate", codexRequestId: 17, threadId: "thread-a", result });
      expect((await restored.wait(message => message.requestId === "duplicate")).ok).toBe(false);
      expect(bridge.responses).toHaveLength(1);
      clock.mockRestore();
      bridge.pending.push({ ...pending, id: 18 });
      bridge.emit("serverRequest", { ...pending, id: 18, accountId: "account-a" });
      bridge.pending = [];
      bridge.emit("notification", { method: "serverRequest/resolved", accountId: "account-a", params: { threadId: "thread-a", requestId: 18 } });
      restored.send({ type: "userInput.respond", requestId: "cancelled", codexRequestId: 18, threadId: "thread-a", result });
      expect((await restored.wait(message => message.requestId === "cancelled")).ok).toBe(false);
      const after = await client(port, "admin"); sockets.push(after.socket);
      expect((await after.wait(message => message.type === "hello")).data.pendingServerRequests).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
      store.close(); fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
