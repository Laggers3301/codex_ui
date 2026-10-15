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

class StickyModeBridge extends EventEmitter {
  mode: string = "default";
  turns: Array<{ mode: string; settings: unknown }> = [];
  getPendingServerRequests() { return []; }
  async request(method: string, params: any) {
    if (method === "turn/start") {
      if (params.collaborationMode) this.mode = params.collaborationMode.mode;
      this.turns.push({ mode: this.mode, settings: params.collaborationMode?.settings });
      return { turn: { id: `turn-${this.turns.length}` } };
    }
    return {};
  }
  complete() {
    this.emit("notification", { method: "turn/completed", params: { threadId: "mode-thread", turn: { id: `turn-${this.turns.length}`, status: "completed", items: [] } } });
  }
}

async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: createSessionCookie("admin") } });
  const messages: any[] = [];
  socket.on("message", raw => messages.push(JSON.parse(String(raw))));
  const wait = (predicate: (message: any) => boolean) => new Promise<any>((resolve, reject) => {
    const existing = messages.find(predicate); if (existing) return resolve(existing);
    const timeout = setTimeout(() => { socket.off("message", listener); reject(new Error("mode socket timeout")); }, 5_000);
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw));
      if (predicate(message)) { clearTimeout(timeout); socket.off("message", listener); resolve(message); }
    };
    socket.on("message", listener);
  });
  await wait(message => message.type === "hello");
  return { socket, wait };
}

describe("leaving native Plan mode", () => {
  it("switches a sticky native thread to Default after reconnect, preserves its model, and allows re-entering Plan", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socket-mode-"));
    const store = new ProjectStore(path.join(root, "store.sqlite"));
    const project = store.createProject({ name: "mode", rootPath: root, defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "max" });
    store.registerThreadOwner({ threadId: "mode-thread", userId: "admin", projectId: project.id, rootPath: root });
    const bridge = new StickyModeBridge(), server = http.createServer();
    const wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const sockets: WebSocket[] = [];
    try {
      let client = await connect((server.address() as { port: number }).port); sockets.push(client.socket);
      for (const [index, mode] of ["plan", "default", "plan"].entries()) {
        if (index === 1) {
          client.socket.terminate();
          client = await connect((server.address() as { port: number }).port); sockets.push(client.socket);
        }
        const requestId = `mode-${index}`;
        client.socket.send(JSON.stringify({ type: "turn.start", requestId, threadId: "mode-thread", projectId: project.id, collaborationMode: mode, prompt: `mode change ${index}` }));
        const ack = await client.wait(message => message.requestId === requestId);
        expect(ack.ok, ack.error).toBe(true);
        expect(bridge.mode).toBe(mode);
        expect(bridge.turns[index].settings).toEqual({ model: "gpt-6.1-sol", reasoning_effort: "max", developer_instructions: null });
        bridge.complete();
      }
      expect(bridge.turns.map(turn => turn.mode)).toEqual(["plan", "default", "plan"]);
    } finally {
      sockets.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
      store.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
