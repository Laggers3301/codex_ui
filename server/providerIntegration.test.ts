import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { attachSocketServer } from "./socket.js";
import { createSessionCookie } from "./auth.js";

it("rejects incompatible model input before invoking the runtime without degrading account health", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-request-integration-"));
  fs.writeFileSync(path.join(root, "model-catalog-gpt-5.6-sol-long-context.json"), JSON.stringify({ models: [{ slug: "fixture", visibility: "list", input_modalities: ["text"] }] }));
  const calls: string[] = [];
  const native = Object.assign(new EventEmitter(), { stop() {}, getPendingServerRequests: () => [], request: async (method: string) => { calls.push(method); return {}; } });
  const pool = new AccountPoolBridge({ accounts: [{ id: "fixture", label: "fixture", codexHome: root, kind: "api-provider" }] }, root, () => native as unknown as CodexBridge);
  pool.assignThreadsToAccount(["thread"], "fixture");
  try {
    native.emit("status", { state: "ready" });
    await expect(pool.request("turn/start", { threadId: "thread", model: "fixture", input: [{ type: "image", url: "fixture" }] })).rejects.toMatchObject({ code: "unsupported_model_capability" });
    expect(calls).toEqual([]);
    await expect(pool.request("turn/start", { threadId: "thread", model: "fixture", input: [{ type: "text", text: "normal" }] })).resolves.toEqual({});
    expect(calls).toEqual(["turn/start"]);
  } finally { pool.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("carries native text/thought/tools through the real pool and WebSocket and clears fatal turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-integration-"));
  const native = Object.assign(new EventEmitter(), { stop() {}, getPendingServerRequests: () => [], request: async () => ({ data: [] }) });
  const pool = new AccountPoolBridge({ accounts: [{ id: "fixture", label: "fixture", codexHome: root, kind: "api-provider" }] }, root, () => native as unknown as CodexBridge);
  pool.assignThreadsToAccount(["thread"], "fixture");
  const store = new ProjectStore(path.join(root, "db.sqlite"));
  const project = store.createProject({ name: "fixture", rootPath: root });
  store.registerThreadOwner({ threadId: "thread", userId: "admin", projectId: project.id, rootPath: root });
  const server = http.createServer(), wss = attachSocketServer(server, pool as unknown as CodexBridge, store);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`, { headers: { cookie: createSessionCookie("admin").split(";")[0] } });
  const events: Record<string, any>[] = [];
  ws.on("message", raw => events.push(JSON.parse(String(raw))));
  const emit = (method: string, params: unknown) => native.emit("notification", { method, params });
  try {
    await vi.waitFor(() => expect(events.some(e => e.type === "hello")).toBe(true));
    emit("turn/started", { threadId: "thread", turn: { id: "r" } });
    emit("item/reasoning/textDelta", { threadId: "thread", turnId: "r", itemId: "thought", delta: "分析中" });
    emit("item/agent_message/delta", { thread_id: "thread", turn_id: "r", item_id: "m", delta: "中文 English 🙂" });
    emit("item/started", { threadId: "thread", turnId: "r", item: { id: "tool", type: "function_call", name: "exec", arguments: '{"cmd":' } });
    emit("item/completed", { threadId: "thread", turnId: "r", item: { id: "tool", type: "function_call", name: "exec", arguments: '{"cmd":"pwd"}', output: "fixture" } });
    emit("item/completed", { threadId: "thread", turnId: "r", item: { id: "m", type: "agent_message", text: "中文 English 🙂 完成" } });
    emit("error", { threadId: "thread", turnId: "r", willRetry: false, error: { message: "fixture stream disconnected", code: "fixture_error" } });
    emit("turn/completed", { threadId: "thread", turn: { id: "r", status: "failed" } });
    await vi.waitFor(() => expect(events.filter(e => e.type === "codex.notification" && e.data.method === "turn/completed")).toHaveLength(1));
    expect(events.some(e => e.type === "codex.notification" && e.data.method === "item/reasoning/textDelta" && e.data.params.delta === "分析中")).toBe(true);
    expect(events.some(e => e.type === "live.tool" && e.data.completed === true)).toBe(true);
    expect(events.some(e => e.type === "live.agent" && e.data.text === "中文 English 🙂 完成")).toBe(true);
    const items = store.readTimelineItems("thread", "r");
    expect(items.find(item => item.id === "m")?.text).toBe("中文 English 🙂 完成");
    expect(items.some(item => item.type === "toolCall")).toBe(true);
    // Reconnection sees no phantom running turn after a fatal error.
    const reconnect = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`, { headers: { cookie: createSessionCookie("admin").split(";")[0] } });
    const hello = await new Promise<any>((resolve, reject) => { reconnect.once("error", reject); reconnect.once("message", raw => resolve(JSON.parse(String(raw)))); });
    reconnect.terminate();
    expect(hello.data.liveState.activeTurns).toHaveLength(0);
  } finally {
    ws.terminate(); wss.clients.forEach(client => client.terminate());
    await new Promise<void>(r => wss.close(() => server.close(() => r())));
    pool.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
