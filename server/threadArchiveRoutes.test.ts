import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { registerRoutes } from "./routes.js";

describe("archive routes", () => {
  it("lists only archived owned threads and routes archive/restore to Codex", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-archive-routes-"));
    const store = new ProjectStore(path.join(temporary, "test.sqlite"));
    const project = store.createProject({ name: "my project", rootPath: temporary });
    store.registerThreadOwner({ threadId: "owned", userId: "admin", projectId: project.id, rootPath: temporary });
    const calls: string[] = [];
    const bridge = { request: async (method: string, params?: { archived?: boolean }) => {
      calls.push(method);
      if (method === "thread/list") return { data: params?.archived
        ? [{ id: "owned", name: "Archived", updatedAt: "2026-09-29T00:00:00Z" }, { id: "foreign", name: "Foreign" }]
        : [{ id: "active", name: "Active" }], nextCursor: null };
      return {};
    } } as unknown as CodexBridge;
    const app = Fastify();
    try {
      registerRoutes(app, bridge, store, { backgroundIndexing: false });
      const listed = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads?archived=true&fast=false` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().data.map((thread: { id: string }) => thread.id)).toEqual(["owned"]);
      expect(store.locallyArchivedThreadIds("admin", project.id).has("owned")).toBe(true);
      const archived = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/owned/archive` });
      expect(store.locallyArchivedThreadIds("admin", project.id).has("owned")).toBe(true);
      const restored = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/owned/unarchive` });
      expect([archived.statusCode, restored.statusCode]).toEqual([200, 200]);
      expect(store.locallyArchivedThreadIds("admin", project.id).has("owned")).toBe(false);
      expect(calls).toContain("thread/archive");
      expect(calls).toContain("thread/unarchive");
      const denied = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/foreign/archive` });
      expect(denied.statusCode).toBe(404);
    } finally { await app.close(); store.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });
});
