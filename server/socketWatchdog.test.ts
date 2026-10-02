import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createSessionCookie } from "./auth.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { attachSocketServer } from "./socket.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

class FakeBridge extends EventEmitter {
  calls: Array<{ method: string; params: unknown }> = [];
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/queue/list") return { data: [] };
    return {};
  }
  getPendingServerRequests() { return []; }
}

describe("socket watchdog runtime exits", () => {
  it("uses the normal interrupted completion path only for the exited account's turns", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "socket-watchdog-"));
    tempDirs.push(temporary);
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const project = store.createProject({ name: "test", rootPath: temporary });
    store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: temporary });
    store.registerThreadOwner({ threadId: "thread-b", userId: "admin", projectId: project.id, rootPath: temporary });
    const bridge = new FakeBridge();
    const server = http.createServer();
    const wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Socket test server did not bind a TCP port.");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { cookie: createSessionCookie("admin") } });
    const messages: Array<{ type?: string; data?: Record<string, unknown> }> = [];
    socket.on("message", (raw) => {
      try { messages.push(JSON.parse(raw.toString()) as { type?: string; data?: Record<string, unknown> }); } catch { /* ignore */ }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    try {
      bridge.emit("notification", { method: "turn/started", accountId: "account-a", params: { threadId: "thread-a", turnId: "turn-a", turn: { id: "turn-a" } } });
      bridge.emit("notification", { method: "turn/started", accountId: "account-b", params: { threadId: "thread-b", turnId: "turn-b", turn: { id: "turn-b" } } });
      bridge.emit("status", { state: "exited", accountId: "account-a", code: 1 });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(bridge.calls.filter((call) => call.method === "thread/queue/list").map((call) => (call.params as { threadId: string }).threadId))
        .toEqual(["thread-a"]);
      expect(bridge.calls.some((call) => call.method === "turn/interrupt" || call.method === "turn/start")).toBe(false);
      expect(messages.some((message) => message.type === "turn.progress" && message.data?.threadId === "thread-a" && message.data?.state === "interrupted")).toBe(true);
      expect(messages.some((message) => message.type === "turn.progress" && message.data?.threadId === "thread-b" && message.data?.state === "interrupted")).toBe(false);

      bridge.emit("status", { state: "exited", accountId: "account-b", code: 1 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(bridge.calls.filter((call) => call.method === "thread/queue/list").map((call) => (call.params as { threadId: string }).threadId))
        .toEqual(["thread-a", "thread-b"]);
    } finally {
      socket.close();
      await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
      store.close();
    }
  });
});
