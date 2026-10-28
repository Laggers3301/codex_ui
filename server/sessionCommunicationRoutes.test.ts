import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("communication HTTP and model tool identity", () => {
  it("uses the bound model identity, supports unbound initialization, and rejects cross-thread argument injection", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "communication-mcp-"));
    vi.stubEnv("CODEX_WEB_DATA_DIR", path.join(root, "private")); vi.stubEnv("CODEX_WEB_AUTH_MODE", "member"); vi.resetModules();
    const [{ ProjectStore }, { registerBrowserRoutes, mintBrowserMcpConfig, bindBrowserMcpThread }, { registerSessionCommunicationRoutes }, { createSessionCookie }] = await Promise.all([
      import("./db.js"), import("./browserRoutes.js"), import("./sessionCommunicationRoutes.js"), import("./auth.js")
    ]);
    const store = new ProjectStore(path.join(root, "store.sqlite")), app = Fastify();
    const project = store.createProject({ name: "tools", rootPath: root });
    store.ensureUser("other", "other");
    for (const threadId of ["a", "b"]) store.registerThreadOwner({ threadId, userId: "admin", projectId: project.id, rootPath: root });
    registerBrowserRoutes(app, store, { get: () => null } as any); registerSessionCommunicationRoutes(app, store);
    try {
      const config = mintBrowserMcpConfig("admin", project.id);
      const headers = (config.config as any)["mcp_servers.codex_communication"].http_headers;
      const rpc = (method: string, args?: unknown, requestHeaders = headers) => app.inject({ method: "POST", url: "/api/communication/mcp", headers: requestHeaders,
        payload: { jsonrpc: "2.0", id: 0, method, params: method === "tools/call" ? { name: "session_communication", arguments: args } : {} } });
      expect((await rpc("initialize")).json()).toMatchObject({ id: 0, result: { serverInfo: { name: "codex-session-communication" } } });
      expect((await rpc("tools/list")).json().result.tools[0].name).toBe("session_communication");
      expect((await rpc("tools/call", { operation: "read" })).json().error.message).toContain("尚未完成绑定");
      expect((await rpc("tools/list", undefined, { "x-codex-browser-token": "forged" })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/communication/mcp", headers,
        payload: { jsonrpc: "2.0", id: { invalid: true }, method: "ping" } })).json()).toMatchObject({ id: null, error: { code: -32600 } });
      bindBrowserMcpThread(config.bindingId!, "a", store);
      expect((await rpc("tools/call", { operation: "topic.subscribe", name: "/status", requestId: "subscribe-bound-a" })).json().result.isError).toBe(false);
      const read = (await rpc("tools/call", { operation: "read" })).json().result;
      expect(JSON.parse(read.content[0].text).threadId).toBe("a"); expect(store.communication.snapshot("admin", "b").bindings).toEqual([]);
      const injected = (await rpc("tools/call", { operation: "topic.subscribe", name: "/status", requestId: "subscribe-forged-b", threadId: "b" })).json().result;
      expect(injected.isError).toBe(true); expect(store.communication.snapshot("admin", "b").bindings).toEqual([]);
      store.communication.execute("admin", "b", { operation: "topic.publish", name: "/status", message: "模型可读消息", requestId: "publish-to-model-a" });
      expect(JSON.parse((await rpc("tools/call", { operation: "read" })).json().result.content[0].text).inbox[0].message).toBe("模型可读消息");
      const cookie = createSessionCookie("admin");
      expect((await app.inject({ url: "/api/threads/a/communication" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/threads/a/communication", headers: { cookie: createSessionCookie("other"), "x-codex-web-user-id": "admin" } })).statusCode).toBe(403);
      expect((await app.inject({ url: "/api/threads/a/communication", headers: { cookie } })).headers["cache-control"]).toBe("no-store");
      const invalid = await app.inject({ method: "POST", url: "/api/threads/a/communication", headers: { cookie }, payload: { operation: "topic.publish", name: "/status", message: "", requestId: "invalid-message" } });
      expect(invalid.statusCode).toBe(400);
      store.setThreadLocallyArchived("a", "admin", project.id, true);
      expect((await rpc("tools/call", { operation: "read" })).json().result.isError).toBe(true);
    } finally { await app.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("sends communication notifications only to the logged-in owner without exposing message contents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "communication-ws-"));
    vi.stubEnv("CODEX_WEB_DATA_DIR", path.join(root, "private")); vi.stubEnv("CODEX_WEB_AUTH_MODE", "member"); vi.resetModules();
    const [{ ProjectStore }, { attachSocketServer }, { createSessionCookie }] = await Promise.all([
      import("./db.js"), import("./socket.js"), import("./auth.js")
    ]);
    const store = new ProjectStore(path.join(root, "store.sqlite"));
    const project = store.createProject({ name: "identity", rootPath: root });
    store.ensureUser("other", "other");
    for (const threadId of ["a", "b"]) store.registerThreadOwner({ threadId, userId: "admin", projectId: project.id, rootPath: root });
    const bridge = Object.assign(new EventEmitter(), { getPendingServerRequests: () => [], request: async () => ({ data: [] }) });
    const server = http.createServer(), wss = attachSocketServer(server, bridge as any, store), sockets: WebSocket[] = [];
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const connect = async (userId: string) => {
      const messages: Array<{ type: string; data: unknown }> = [];
      const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws`, { headers: { cookie: createSessionCookie(userId).split(";")[0] } });
      sockets.push(socket); socket.on("message", raw => messages.push(JSON.parse(String(raw))));
      await vi.waitFor(() => expect(messages.some(message => message.type === "hello")).toBe(true));
      return messages;
    };
    try {
      const own = await connect("admin"), other = await connect("other");
      store.communication.execute("admin", "b", { operation: "topic.subscribe", name: "/status", requestId: "ws-subscribe-b" });
      store.communication.execute("admin", "a", { operation: "topic.publish", name: "/status", message: "private-message-body", requestId: "ws-publish-a" });
      await vi.waitFor(() => expect(own.filter(message => message.type === "communication.changed")).toHaveLength(2));
      const changes = own.filter(message => message.type === "communication.changed");
      expect(changes[1].data).toEqual({ threadIds: ["a", "b"] });
      expect(JSON.stringify(changes)).not.toContain("private-message-body");
      expect(other.some(message => message.type === "communication.changed")).toBe(false);
    } finally {
      sockets.forEach(socket => socket.terminate()); wss.clients.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
      expect(store.communication.listenerCount("change")).toBe(0);
      store.close(); fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
