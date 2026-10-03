import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("browser routes and MCP scope", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("isolates pending thread bindings and enforces live owner scope on HTTP and MCP", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "browser-routes-"));
    vi.stubEnv("CODEX_WEB_DATA_DIR", path.join(temporary, "private-data"));
    vi.stubEnv("CODEX_WEB_AUTH_MODE", "member");
    vi.resetModules();

    const root = path.join(temporary, "workspace");
    fs.mkdirSync(path.join(root, "nested"), { recursive: true });
    const visibleThreads = new Set(["thread-1"]);
    const store = {
      getProject: (id: string, userId: string) => id === "p" && userId === "alice" ? { id, rootPath: root } : null,
      getThreadOwner: (threadId: string) => threadId === "thread-1" && visibleThreads.has(threadId)
        ? { threadId, userId: "alice", projectId: "p", rootPath: path.join(root, "nested") }
        : null,
      userCanAccessThread: (threadId: string, userId: string) => threadId === "thread-1" && userId === "alice" && visibleThreads.has(threadId)
    };
    const calls: Array<{ userId: string; threadId: string; actor: string }> = [];
    const service = {
      get: () => null,
      open: async () => ({ id: "browser", status: "ready" }),
      control: async () => ({ id: "browser", status: "ready" }),
      action: async (userId: string, threadId: string, _args: unknown, actor: string) => {
        calls.push({ userId, threadId, actor });
        return { state: { id: "browser" }, text: "snapshot text" };
      },
      approve: () => undefined,
      close: async () => undefined,
      frame: () => ({ data: Buffer.from("jpeg-bytes"), version: 7 })
    };

    const { registerBrowserRoutes, mintBrowserMcpConfig, bindBrowserMcpThread, browserMcpAuthorized } = await import("./browserRoutes.js");
    const { createSessionCookie } = await import("./auth.js");
    const app = Fastify();
    try {
      registerBrowserRoutes(app, store as any, service as any);
      const aliceCookie = createSessionCookie("alice").split(";")[0];
      const bobCookie = createSessionCookie("bob").split(";")[0];

      const denied = await app.inject({ method: "GET", url: "/api/projects/p/threads/thread-1/browser", headers: { cookie: bobCookie } });
      expect(denied.statusCode).toBe(404);

      const frame = await app.inject({ method: "GET", url: "/api/projects/p/threads/thread-1/browser/frame", headers: { cookie: aliceCookie } });
      expect(frame.statusCode).toBe(200);
      expect(frame.headers["content-type"]).toContain("image/jpeg");

      const pendingA = mintBrowserMcpConfig("alice", "p");
      const pendingB = mintBrowserMcpConfig("alice", "p");
      expect(pendingA.bindingId).toBeTruthy();
      expect(pendingB.bindingId).toBeTruthy();
      expect(pendingA.bindingId).not.toBe(pendingB.bindingId);
      const getToken = (minted: typeof pendingA) => (minted.config as any)["mcp_servers.codex_browser"].http_headers["x-codex-browser-token"] as string;
      const tokenA = getToken(pendingA), tokenB = getToken(pendingB);
      expect(browserMcpAuthorized({ "x-codex-browser-token": tokenA })).toBe(true);
      expect(browserMcpAuthorized({ "x-codex-browser-token": `${tokenA}x` })).toBe(false);

      bindBrowserMcpThread(pendingA.bindingId!, "thread-1", store as any);
      const firstCall = await app.inject({
        method: "POST", url: "/api/browser/mcp", headers: { "x-codex-browser-token": tokenA },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_action", arguments: { action: "snapshot" } } }
      });
      expect(firstCall.statusCode).toBe(200);
      expect(firstCall.json().result.content[0].text).toBe("snapshot text");
      expect(calls).toEqual([{ userId: "alice", threadId: "thread-1", actor: "agent" }]);

      const stillUnbound = await app.inject({
        method: "POST", url: "/api/browser/mcp", headers: { "x-codex-browser-token": tokenB },
        payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_action", arguments: { action: "snapshot" } } }
      });
      expect(stillUnbound.json().result.isError).toBe(true);
      expect(calls).toHaveLength(1);

      const initialized = await app.inject({
        method: "POST", url: "/api/browser/mcp", headers: { "x-codex-browser-token": tokenA },
        payload: { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {} } }
      });
      expect(initialized.json().result.protocolVersion).toBe("2025-03-26");

      visibleThreads.clear();
      expect(browserMcpAuthorized({ "x-codex-browser-token": tokenA })).toBe(false);
      const revoked = await app.inject({
        method: "POST", url: "/api/browser/mcp", headers: { "x-codex-browser-token": tokenA },
        payload: { jsonrpc: "2.0", id: 4, method: "tools/list" }
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await app.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
