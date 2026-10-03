import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "./db.js";

describe("scheduled task routes", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
  it("enforces user+project+thread scope for schedule reads and writes", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-routes-"));
    vi.stubEnv("CODEX_WEB_DATA_DIR", path.join(temporary, "server-data")); vi.stubEnv("CODEX_WEB_AUTH_MODE", "member"); vi.resetModules();
    const root = path.join(temporary, "workspace"); fs.mkdirSync(root, { recursive: true });
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    store.ensureUser("alice", "alice");
    const project = store.createProject({ name: "test", rootPath: root, userId: "alice" });
    store.registerThreadOwner({ threadId: "alice-thread", userId: "alice", projectId: project.id, rootPath: root });
    const app = Fastify();
    try {
      const [{ registerRoutes }, { createSessionCookie }] = await Promise.all([import("./routes.js"), import("./auth.js")]);
      registerRoutes(app, { request: async () => ({}) } as any, store, { backgroundIndexing: false });
      const alice = { cookie: createSessionCookie("alice").split(";")[0] };
      const bob = { cookie: createSessionCookie("bob").split(";")[0] };
      const url = `/api/projects/${project.id}/threads/alice-thread/schedules`;
      const created = await app.inject({ method: "POST", url, headers: alice, payload: { prompt: "Run later", schedule: { kind: "interval", intervalMinutes: 5, timezone: "UTC" } } });
      expect(created.statusCode).toBe(201); expect(created.json().data.status).toBe("scheduled");
      expect((await app.inject({ method: "GET", url, headers: alice })).json().data).toHaveLength(1);
      expect((await app.inject({ method: "GET", url, headers: bob })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: url.replace("alice-thread", "other-thread"), headers: alice, payload: { prompt: "wrong thread", schedule: { kind: "interval", intervalMinutes: 5, timezone: "UTC" } } })).statusCode).toBe(403);
      const taskUrl = `${url}/${created.json().data.id}`;
      expect((await app.inject({ method: "PATCH", url: taskUrl, headers: bob, payload: { enabled: false } })).statusCode).toBe(404);
      const paused = await app.inject({ method: "PATCH", url: taskUrl, headers: alice, payload: { enabled: false, title: "Paused task" } });
      expect(paused.statusCode).toBe(200);
      expect(paused.json().data).toMatchObject({ enabled: false, nextRunAt: null, title: "Paused task" });
      expect((await app.inject({ method: "DELETE", url: taskUrl, headers: bob })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: taskUrl, headers: alice })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url, headers: alice })).json().data).toEqual([]);
      expect((await app.inject({ method: "POST", url, headers: alice, payload: { prompt: "too often", schedule: { kind: "interval", intervalMinutes: 4, timezone: "UTC" } } })).statusCode).toBe(400);
    } finally { await app.close(); store.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });
});
