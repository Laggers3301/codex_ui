import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { createSessionCookie } from "./auth.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { closeSideChat } from "./sideChats.js";
import { attachSocketServer } from "./socket.js";

class Bridge extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  threadGate: Promise<void> | null = null;
  turnGate: Promise<void> | null = null;
  getPendingServerRequests() { return []; }
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "thread/start" || method === "thread/fork") { await this.threadGate; return { thread: { id: "side-child", cwd: params.cwd } }; }
    if (method === "turn/start") {
      const id = "turn-" + this.calls.filter(call => call.method === "turn/start").length;
      await this.turnGate;
      this.emit("notification", { method: "turn/started", params: { threadId: params.threadId, turn: { id } } });
      return { turn: { id } };
    }
    if (method === "turn/interrupt") this.complete(params.threadId, params.turnId, "interrupted");
    return {};
  }
  complete(threadId: string, id: string, status = "completed") {
    this.emit("notification", { method: "turn/completed", params: { threadId, turn: { id, status, items: [] } } });
  }
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socket-side-chat-")), store = new ProjectStore(path.join(root, "store.sqlite"));
  const project = store.createProject({ name: "main", rootPath: root });
  store.registerThreadOwner({ threadId: "main", userId: "admin", projectId: project.id, rootPath: root });
  const side = store.sideChats.create("main", "admin", project.id, "selected quotation", "sol");
  const bridge = new Bridge(), server = http.createServer(), wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`, { headers: { cookie: createSessionCookie("admin") } });
  const messages: any[] = [];
  socket.on("message", raw => messages.push(JSON.parse(String(raw))));
  const wait = (predicate: (message: any) => boolean) => new Promise<any>((resolve, reject) => {
    const found = messages.find(predicate); if (found) return resolve(found);
    const timer = setTimeout(() => { socket.off("message", listener); reject(new Error("side chat socket timeout")); }, 5000);
    const listener = (raw: WebSocket.RawData) => { const message = JSON.parse(String(raw)); if (predicate(message)) { clearTimeout(timer); socket.off("message", listener); resolve(message); } };
    socket.on("message", listener);
  });
  await wait(message => message.type === "hello");
  return { store, project, side, bridge, socket, wait, send: (message: object) => socket.send(JSON.stringify({ projectId: project.id, sideChatId: side.id, ...message })),
    dispose: async () => { socket.terminate(); await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); await new Promise(resolve => setTimeout(resolve, 30)); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

it("forks the parent context once and continues the bound child without forking again", async () => {
  const f = await fixture();
  try {
    f.send({ type: "thread.start", requestId: "first", prompt: "question" });
    expect((await f.wait(message => message.requestId === "first")).ok).toBe(true);
    expect(f.store.sideChats.get("main", "admin", f.project.id)).toMatchObject({ threadId: "side-child", status: "running" });
    f.bridge.complete("side-child", "turn-1");
    await f.wait(message => message.type === "side.chat" && message.data.sideChat?.status === "complete");
    f.send({ type: "turn.start", requestId: "second", threadId: "side-child", prompt: "follow up" });
    expect((await f.wait(message => message.requestId === "second")).ok).toBe(true);
    expect(f.bridge.calls.filter(call => call.method === "thread/start")).toHaveLength(0);
    expect(f.bridge.calls.filter(call => call.method === "thread/fork")).toEqual([{ method: "thread/fork", params: expect.objectContaining({ threadId: "main", excludeTurns: true, deferGoalContinuation: true }) }]);
    expect(f.bridge.calls.filter(call => call.method === "thread/goal/clear")).toEqual([{ method: "thread/goal/clear", params: { threadId: "side-child", origin: "automatic" } }]);
    expect(f.bridge.calls.find(call => call.method === "turn/start")?.params.collaborationMode.mode).toBe("default");
    expect(f.bridge.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
    expect(f.store.sideChats.get("main", "admin", f.project.id)?.parentThreadId).toBe("main");
  } finally { await f.dispose(); }
});

it("does not silently start an empty thread when the parent fork fails", async () => {
  const f = await fixture(), request = f.bridge.request.bind(f.bridge);
  f.bridge.request = async (method, params) => {
    if (method === "thread/fork") throw new Error("parent context unavailable");
    return request(method, params);
  };
  try {
    f.send({ type: "thread.start", requestId: "fork-error", prompt: "remember earlier" });
    expect(await f.wait(message => message.requestId === "fork-error")).toMatchObject({ ok: false, error: "parent context unavailable" });
    expect(f.bridge.calls.some(call => call.method === "thread/start" || call.method === "turn/start")).toBe(false);
    expect(f.store.sideChats.byId(f.side.id, "admin")).toMatchObject({ status: "error", threadId: null, lastPrompt: "remember earlier" });
    expect(f.store.userCanAccessThread("main", "admin", f.project.id)).toBe(true);
  } finally { await f.dispose(); }
});

it("keeps the question retryable and hides a fork whose inherited goal could not be cleared", async () => {
  const f = await fixture(), request = f.bridge.request.bind(f.bridge);
  f.bridge.request = async (method, params) => {
    if (method === "thread/goal/clear") throw new Error("goal clear unavailable");
    return request(method, params);
  };
  try {
    f.send({ type: "thread.start", requestId: "goal-error", prompt: "side question" });
    expect(await f.wait(message => message.requestId === "goal-error")).toMatchObject({ ok: false, error: "goal clear unavailable" });
    expect(f.bridge.calls.some(call => call.method === "turn/start")).toBe(false);
    expect(f.store.sideChats.byId(f.side.id, "admin")).toMatchObject({ status: "error", threadId: null, lastPrompt: "side question" });
    expect(f.store.userCanAccessThread("side-child", "admin", f.project.id)).toBe(false);
    expect(f.store.userCanAccessThread("main", "admin", f.project.id)).toBe(true);
  } finally { await f.dispose(); }
});

it("cancels an in-flight native thread creation when its bound side chat is closed", async () => {
  const f = await fixture(); let release!: () => void;
  f.bridge.threadGate = new Promise(resolve => { release = resolve; });
  try {
    f.send({ type: "thread.start", requestId: "pending", prompt: "question" });
    await f.wait(message => message.type === "side.chat" && message.data.sideChat?.status === "starting");
    await closeSideChat(f.bridge as unknown as CodexBridge, f.store, f.store.sideChats.byId(f.side.id, "admin")!);
    release();
    expect((await f.wait(message => message.requestId === "pending")).ok).toBe(false);
    expect(f.bridge.calls.filter(call => call.method === "turn/start")).toHaveLength(0);
    expect(f.store.sideChats.get("main", "admin", f.project.id)).toBeNull();
    expect(f.store.userCanAccessThread("main", "admin", f.project.id)).toBe(true);
    expect(f.store.userCanAccessThread("side-child", "admin", f.project.id)).toBe(false);
  } finally { release(); await f.dispose(); }
});

it("interrupts a late accepted turn after close and leaves the parent accessible", async () => {
  const f = await fixture(); let release!: () => void;
  f.bridge.turnGate = new Promise(resolve => { release = resolve; });
  try {
    f.send({ type: "thread.start", requestId: "pending-turn", prompt: "question" });
    await f.wait(message => message.type === "side.chat" && message.data.sideChat?.threadId === "side-child");
    await closeSideChat(f.bridge as unknown as CodexBridge, f.store, f.store.sideChats.byId(f.side.id, "admin")!);
    release();
    await f.wait(message => message.type === "side.chat" && message.data.sideChat === null);
    expect(f.bridge.calls.filter(call => call.method === "turn/interrupt").every(call => call.params.threadId === "side-child")).toBe(true);
    expect(f.bridge.calls.some(call => call.method === "turn/interrupt")).toBe(true);
    expect(f.store.sideChats.get("main", "admin", f.project.id)).toBeNull();
    expect(f.store.userCanAccessThread("main", "admin", f.project.id)).toBe(true);
  } finally { release(); await f.dispose(); }
});
