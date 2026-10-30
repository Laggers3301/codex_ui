import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createSessionCookie } from "./auth.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { attachSocketServer } from "./socket.js";

type Message = { type: string; requestId?: string; ok?: boolean; data?: any; error?: string };
class Bridge extends EventEmitter {
  pending: any[] = [];
  responses: any[] = [];
  calls: any[] = [];
  flags: string[] = [];
  readGate: Promise<void> | null = null;
  getPendingServerRequests() { return this.pending; }
  async request(method: string, params: unknown) {
    this.calls.push({ method, params });
    if (method === "thread/read") { const activeFlags = [...this.flags]; await this.readGate; return { thread: { status: { type: "active", activeFlags } } }; }
    if (method === "thread/queue/list") return { data: [] };
    return {};
  }
  respondToServerRequest(id: string | number, result: unknown) {
    this.responses.push({ id, result }); this.pending = this.pending.filter(request => request.id !== id);
  }
}
async function fixture(run: (test: any) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socket-approvals-"));
  const store = new ProjectStore(path.join(root, "store.sqlite")), bridge = new Bridge(), server = http.createServer();
  const project = store.createProject({ name: "approval test", rootPath: root });
  store.ensureUser("other", "other");
  store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: root });
  const wss = attachSocketServer(server, bridge as unknown as CodexBridge, store), sockets: WebSocket[] = [];
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = async (user = "admin") => {
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`, { headers: { cookie: createSessionCookie(user) } });
    sockets.push(socket); const messages: Message[] = [];
    socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
    const wait = async (predicate: (message: Message) => boolean) => {
      for (let count = 0; count < 100; count++) { const message = messages.find(predicate); if (message) return message; await new Promise(resolve => setTimeout(resolve, 10)); }
      throw new Error("Socket message timed out: " + JSON.stringify(messages));
    };
    const hello = await wait(message => message.type === "hello");
    return { messages, hello, wait, send: (message: unknown) => socket.send(JSON.stringify(message)) };
  };
  const start = (turnId = "turn-a") => bridge.emit("notification", { method: "turn/started", accountId: "account-a", params: { threadId: "thread-a", turn: { id: turnId } } });
  const approval = (id: number, method = "item/permissions/requestApproval", emit = true) => {
    const request = { id, method, accountId: "account-a", receivedAt: new Date().toISOString(), params: {
      threadId: "thread-a", turnId: "turn-a", itemId: "operation-" + id,
      reason: "允许测试指定路径", permissions: { network: null, fileSystem: { read: ["/tmp/requested"], write: null } }
    } };
    bridge.pending.push(request); if (emit) bridge.emit("serverRequest", request); return request;
  };
  try { await run({ bridge, client, start, approval }); }
  finally { sockets.forEach(socket => socket.terminate()); await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

describe("socket approvals", () => {
  it("restores permission requests, isolates users, and keeps the second approval waiting", () => fixture(async ({ bridge, client, start, approval }: any) => {
    const first = await client(); start(); const request = approval(1); approval(2, "item/commandExecution/requestApproval");
    const restored = await client(), other = await client("other");
    expect(restored.hello.data.pendingServerRequests.map((request: any) => request.id)).toEqual([1, 2]);
    expect(other.hello.data.pendingServerRequests).toEqual([]);
    other.send({ type: "approval.respond", requestId: "foreign", codexRequestId: 1, result: { decision: "accept" } });
    expect((await other.wait((m: Message) => m.requestId === "foreign")).ok).toBe(false);
    restored.send({ type: "approval.respond", requestId: "wrong-thread", threadId: "thread-b", codexRequestId: 1, result: { decision: "accept" } });
    expect((await restored.wait((m: Message) => m.requestId === "wrong-thread")).ok).toBe(false);
    first.messages.length = 0;
    restored.send({ type: "approval.respond", requestId: "allow", threadId: "thread-a", codexRequestId: 1, result: { decision: "accept", scope: "session", permissions: { network: { enabled: true } } } });
    expect((await restored.wait((m: Message) => m.requestId === "allow")).ok).toBe(true);
    expect(bridge.responses).toEqual([{ id: 1, result: { permissions: { fileSystem: request.params.permissions.fileSystem }, scope: "turn" } }]);
    expect((await first.wait((m: Message) => m.type === "turn.progress")).data.state).toBe("waiting_approval");
    expect(bridge.pending.map((r: any) => r.id)).toEqual([2]); expect(bridge.calls).toEqual([]);
  }));

  it("rehydrates missed requests with a bounded read and never executes or approves an operation", () => fixture(async ({ bridge, client, start, approval }: any) => {
    const tab = await client(); start(); approval(1, undefined, false);
    tab.send({ type: "approval.sync", requestId: "sync", threadId: "thread-a", turnId: "turn-a" });
    const result = await tab.wait((m: Message) => m.requestId === "sync");
    expect(result.ok).toBe(true); expect(result.data.pendingServerRequests).toHaveLength(1);
    expect(bridge.calls).toEqual([{ method: "thread/read", params: { threadId: "thread-a", includeTurns: false } }]); expect(bridge.responses).toEqual([]);
    const other = await client("other"); other.send({ type: "approval.sync", requestId: "foreign-sync", threadId: "thread-a" });
    expect((await other.wait((m: Message) => m.requestId === "foreign-sync")).ok).toBe(false); expect(bridge.calls).toHaveLength(1);
  }));

  it("clears stale native wait flags but preserves real pending approvals", () => fixture(async ({ bridge, client, start, approval }: any) => {
    const tab = await client(); start();
    const status = (activeFlags: string[]) => bridge.emit("notification", { method: "thread/status/changed", accountId: "account-a", params: { threadId: "thread-a", status: { type: "active", activeFlags } } });
    status(["waitingOnApproval"]); await tab.wait((m: Message) => m.type === "turn.progress" && m.data.state === "waiting_approval");
    tab.messages.length = 0; status([]);
    expect((await tab.wait((m: Message) => m.type === "turn.progress")).data.state).toBe("active");
    approval(1); await tab.wait((m: Message) => m.type === "turn.progress" && m.data.state === "waiting_approval");
    tab.messages.length = 0;
    tab.send({ type: "approval.sync", requestId: "still-pending", threadId: "thread-a", turnId: "turn-a" });
    expect((await tab.wait((m: Message) => m.requestId === "still-pending")).ok).toBe(true);
    expect((await tab.wait((m: Message) => m.type === "turn.progress")).data.state).toBe("waiting_approval");
  }));

  it("explains a native wait without a pending request and leaves it unapproved", () => fixture(async ({ bridge, client, start }: any) => {
    const tab = await client(); start(); bridge.flags = ["waitingOnApproval"];
    tab.send({ type: "approval.sync", requestId: "missing-details", threadId: "thread-a", turnId: "turn-a" });
    const result = await tab.wait((m: Message) => m.requestId === "missing-details");
    expect(result.data.message).toContain("未返回可操作的批准请求"); expect(result.data.pendingServerRequests).toEqual([]); expect(bridge.responses).toEqual([]);
    bridge.flags = []; tab.send({ type: "approval.sync", requestId: "cleared", threadId: "thread-a", turnId: "turn-a" });
    expect((await tab.wait((m: Message) => m.requestId === "cleared")).data.message).toContain("未发现待批准操作");
    expect(tab.messages.filter((m: Message) => m.type === "turn.progress").at(-1).data.state).toBe("no_progress");
  }));

  it("does not apply an old inspection to a newly started turn", () => fixture(async ({ bridge, client, start }: any) => {
    const tab = await client(); start(); let release!: () => void;
    bridge.readGate = new Promise<void>(resolve => { release = resolve; }); bridge.flags = ["waitingOnApproval"];
    tab.send({ type: "approval.sync", requestId: "race", threadId: "thread-a", turnId: "turn-a" });
    await tab.wait(() => bridge.calls.length === 1); start("turn-new"); release();
    const result = await tab.wait((m: Message) => m.requestId === "race"); expect(result.ok).toBe(false); expect(result.error).toContain("运行状态已变化");
    expect(tab.messages.some((m: Message) => m.type === "turn.progress" && m.data.turnId === "turn-new" && m.data.state === "waiting_approval")).toBe(false);
  }));

  it("does not restore an old approval flag after newer tool progress on the same turn", () => fixture(async ({ bridge, client, start }: any) => {
    const tab = await client(); start(); let release!: () => void;
    bridge.readGate = new Promise<void>(resolve => { release = resolve; }); bridge.flags = ["waitingOnApproval"];
    tab.send({ type: "approval.sync", requestId: "progress-race", threadId: "thread-a", turnId: "turn-a" });
    await tab.wait(() => bridge.calls.length === 1);
    bridge.emit("notification", { method: "item/agentMessage/delta", accountId: "account-a", params: { threadId: "thread-a", turnId: "turn-a", itemId: "answer", delta: "已经继续执行" } });
    release();
    expect((await tab.wait((m: Message) => m.requestId === "progress-race")).ok).toBe(false);
    expect(tab.messages.some((m: Message) => m.type === "turn.progress" && m.data.state === "waiting_approval")).toBe(false);
  }));
});
