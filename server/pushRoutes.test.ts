import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ProjectStore } from "./db.js";
import { sendUserPush } from "./webPush.js";
vi.mock("./webPush.js", () => ({ sendUserPush: vi.fn().mockResolvedValue({ subscriptions: 0, accepted: 0, failed: 0 }), pushPublicKey: vi.fn() }));

describe("notification subscription and test routes", () => {
  it("saves native subscription JSON and limits test pushes to the caller's own thread", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-routes-"));
    vi.stubEnv("CODEX_WEB_DATA_DIR", path.join(dir, "server-data"));
    vi.stubEnv("CODEX_WEB_AUTH_MODE", "member");
    vi.resetModules();
    const store = new ProjectStore(path.join(dir, "store.sqlite"));
    store.ensureUser("alice", "alice"); store.ensureUser("bob", "bob");
    const project = store.createProject({ name: "test", rootPath: dir, userId: "alice" });
    store.registerThreadOwner({ threadId: "alice-thread", userId: "alice", projectId: project.id, rootPath: dir });
    const app = Fastify();
    try {
      const [{ registerRoutes }, { createSessionCookie }] = await Promise.all([import("./routes.js"), import("./auth.js")]);
      registerRoutes(app, { request: async () => ({}) } as any, store, { backgroundIndexing: false });
      const alice = { cookie: createSessionCookie("alice") }, bob = { cookie: createSessionCookie("bob") };
      const subscription = { endpoint: "https://fcm.googleapis.com/example", expirationTime: null, keys: { p256dh: "x".repeat(65), auth: "x".repeat(22) } };
      expect((await app.inject({ method: "POST", url: "/api/push/subscription", headers: alice, payload: subscription })).statusCode).toBe(200);
      expect(store.listPushSubscriptions("alice")).toHaveLength(1);
      expect(store.listPushSubscriptions("bob")).toHaveLength(0);
      const callsBefore = vi.mocked(sendUserPush).mock.calls.length;
      expect((await app.inject({ method: "POST", url: "/api/push/test", headers: bob, payload: { threadId: "alice-thread" } })).statusCode).toBe(403);
      expect(vi.mocked(sendUserPush).mock.calls).toHaveLength(callsBefore);
      const result = await app.inject({ method: "POST", url: "/api/push/test", headers: alice, payload: { threadId: "alice-thread" } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toEqual({ data: { subscriptions: 0, accepted: 0, failed: 0 } });
      expect(vi.mocked(sendUserPush).mock.calls.at(-1)?.[2]).toMatchObject({ type: "test", threadId: "alice-thread", projectId: project.id });
    } finally {
      await app.close(); store.close(); vi.unstubAllEnvs(); vi.resetModules();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
