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
  parameters: Array<{ method: string; params: any }> = [];
  rejectNextStart = false;
  getPendingServerRequests() { return this.pending; }
  respondToServerRequest(id: number | string, result: unknown) {
    this.responses.push({ id, result });
    this.pending = this.pending.filter(request => request.id !== id);
  }
  async request(method: string, params: any = {}) {
    this.calls.push(method); this.parameters.push({ method, params });
    if (method === "thread/loaded/list") return { data: ["thread-a"] };
    if (method === "turn/start") {
      if (this.rejectNextStart) { this.rejectNextStart = false; throw new Error("模拟工具答案发送失败"); }
      return { turn: { id: "answer-turn" } };
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

describe("native question answers over the socket", () => {
  it("persists upstream typed async questions and answers them after completion and reconnect", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "socket-typed-questions-"));
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const project = store.createProject({ name: "test", rootPath: temporary });
    store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: temporary });
    const bridge = new FakeBridge(), server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const sockets: WebSocket[] = [];
    try {
      const first = await client((server.address() as { port: number }).port, "admin"); sockets.push(first.socket);
      bridge.emit("notification", { method: "turn/started", params: { threadId: "thread-a", turn: { id: "original" } } });
      const questions = [{ title: "新格式的问题", options: ["A", "B"] }];
      const item = { type: "agentMessage", id: "typed-question", delivery: "async", text: "请选择", questions };
      for (const method of ["item/started", "item/completed"]) bridge.emit("notification", { method, params: { threadId: "thread-a", turnId: "original", item } });
      await first.wait(message => message.type === "live.tool");
      expect(store.readTimelineItem("thread-a", item.id)).toMatchObject({ tool: "request_user_input_async" });
      bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-a", turn: { id: "original", status: "completed" } } });
      const restored = await client((server.address() as { port: number }).port, "admin"); sockets.push(restored.socket);
      for (const [id, raw] of [
        [item.id, null],
        ["raw-function", { type: "functionCall", name: "functions.request_user_input_async", arguments: JSON.stringify({ questions }) }],
        ["raw-agent", { type: "agentMessage", delivery: "async", text: "请选择", questions }],
      ] as const) {
        if (raw) store.saveTimelineItem("thread-a", "original", { id, ...raw });
        restored.send({ type: "question.respond", requestId: id, projectId: project.id, threadId: "thread-a", itemId: id, answers: ["A"] });
        const ack = await restored.wait(message => message.requestId === id);
        expect(ack.ok, JSON.stringify(ack)).toBe(true);
        expect(bridge.parameters.filter(row => row.method === "turn/start").at(-1)?.params).toMatchObject({ input: [], toolOutput: { name: "request_user_input_async" } });
      }
      expect(store.answeredQuestionItemIds("thread-a", "admin")).toHaveLength(3);
    } finally {
      sockets.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
      store.close(); fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("keeps a second nonblocking native request across answering the first and completing its turn", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "socket-parallel-input-"));
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const project = store.createProject({ name: "test", rootPath: temporary });
    store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: temporary });
    const bridge = new FakeBridge(), server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const sockets: WebSocket[] = [];
    try {
      const port = (server.address() as { port: number }).port;
      const first = await client(port, "admin"); sockets.push(first.socket);
      bridge.emit("notification", { method: "turn/started", params: { threadId: "thread-a", turn: { id: "turn-a" } } });
      for (const id of [17, 18]) {
        const request = { id, method: "item/tool/requestUserInput", params: {
          threadId: "thread-a", turnId: "turn-a", itemId: "question-" + id, isBlocking: false,
          questions: [{ id: "answer", question: "问题 " + id, options: null }]
        }, receivedAt: new Date().toISOString() };
        bridge.pending.push(request); bridge.emit("serverRequest", request);
      }
      first.send({ type: "userInput.respond", requestId: "first", codexRequestId: 17, threadId: "thread-a", result: { answers: { answer: { answers: ["第一个答案"] } } } });
      expect((await first.wait(m => m.requestId === "first")).ok).toBe(true);
      expect(bridge.pending.map(request => request.id)).toEqual([18]);
      expect(store.answeredQuestionItemIds("thread-a", "admin")).toEqual(["question-17"]);
      bridge.emit("notification", { method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } } });
      const restored = await client(port, "admin"); sockets.push(restored.socket);
      expect((await restored.wait(m => m.type === "hello")).data.pendingServerRequests.map((request: { id: number }) => request.id)).toEqual([18]);
      restored.send({ type: "userInput.respond", requestId: "second", codexRequestId: 18, threadId: "thread-a", result: { answers: { answer: { answers: ["第二个答案"] } } } });
      expect((await restored.wait(m => m.requestId === "second")).ok).toBe(true);
      expect(bridge.responses.map(response => response.id)).toEqual([17, 18]);
      expect(store.answeredQuestionItemIds("thread-a", "admin").sort()).toEqual(["question-17", "question-18"]);
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
      store.close(); fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("delivers async answers as correlated tool outputs and persists each question independently", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "socket-async-questions-"));
    const file = path.join(temporary, "store.sqlite"), store = new ProjectStore(file);
    const project = store.createProject({ name: "test", rootPath: temporary });
    store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: temporary });
    store.ensureUser("other", "other");
    for (const id of ["question-a", "question-b"]) store.saveTimelineItem("thread-a", "turn-original", {
      id, type: "toolCall", tool: "functions.request_user_input_async", completed: true,
      input: JSON.stringify({ questions: [{ title: id, options: ["A", "B"] }] }), output: '{"accepted":true}'
    });
    const bridge = new FakeBridge(), server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const sockets: WebSocket[] = [];
    try {
      const port = (server.address() as { port: number }).port;
      const first = await client(port, "admin"), tab = await client(port, "admin"), foreign = await client(port, "other");
      sockets.push(first.socket, tab.socket, foreign.socket);
      const answer = { type: "question.respond", projectId: project.id, threadId: "thread-a", itemId: "question-a", answers: ["A"] };
      foreign.send({ ...answer, requestId: "foreign" });
      expect((await foreign.wait(m => m.requestId === "foreign")).ok).toBe(false);
      first.send({ ...answer, itemId: "missing", requestId: "missing" });
      expect((await first.wait(m => m.requestId === "missing")).ok).toBe(false);
      first.send({ ...answer, answers: [], requestId: "partial" });
      expect((await first.wait(m => m.requestId === "partial")).ok).toBe(false);
      bridge.rejectNextStart = true;
      first.send({ ...answer, requestId: "failed" });
      expect((await first.wait(m => m.requestId === "failed")).ok).toBe(false);
      expect(store.answeredQuestionItemIds("thread-a", "admin")).toEqual([]);
      first.send({ ...answer, requestId: "accepted" });
      expect((await first.wait(m => m.requestId === "accepted")).ok).toBe(true);
      expect((await tab.wait(m => m.type === "question.answered")).data).toEqual({ threadId: "thread-a", itemId: "question-a", answer: ["A"] });
      expect(store.answeredQuestionItemIds("thread-a", "admin")).toEqual(["question-a"]);
      const params = bridge.parameters.filter(row => row.method === "turn/start").at(-1)!.params;
      expect(params.input).toEqual([]);
      expect(params.toolOutput).toMatchObject({ name: "request_user_input_async", namespace: "functions", retain: true });
      expect(JSON.parse(params.toolOutput.output)).toMatchObject({ type: "codex_web_question_answer", itemId: "question-a", questions: [{ question: "question-a", answer: "A" }] });
      first.send({ ...answer, requestId: "duplicate" });
      expect((await first.wait(m => m.requestId === "duplicate")).ok).toBe(true);
      expect(bridge.parameters.filter(row => row.method === "turn/start")).toHaveLength(2);
      const reopened = new ProjectStore(file);
      try { expect(reopened.answeredQuestionItemIds("thread-a", "admin")).toEqual(["question-a"]); }
      finally { reopened.close(); }
      expect(store.answeredQuestionItemIds("thread-a", "other")).toEqual([]);
      first.send({ ...answer, itemId: "question-b", answers: ["自定义\n第二个问题"], requestId: "second" });
      expect((await first.wait(m => m.requestId === "second")).ok).toBe(true);
      expect(store.answeredQuestionItemIds("thread-a", "admin").sort()).toEqual(["question-a", "question-b"]);
      expect(bridge.calls.some(method => method === "turn/steer" || method === "thread/queue/add")).toBe(false);
      expect(bridge.responses).toEqual([]);
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
      store.close(); fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

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
