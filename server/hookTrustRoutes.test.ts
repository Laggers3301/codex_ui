import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { registerRoutes } from "./routes.js";

describe("project Hook trust routes", () => {
  it("shows safe local details but rejects global or stale trust grants", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks-routes-"));
    const projectRoot = path.join(temporary, "project");
    fs.mkdirSync(path.join(projectRoot, ".codex"), { recursive: true });
    const manifest = path.join(projectRoot, ".codex", "hooks.json"); fs.writeFileSync(manifest, "{}");
    const globalManifest = path.join(temporary, "global.json"); fs.writeFileSync(globalManifest, "{}");
    const store = new ProjectStore(path.join(temporary, "test.sqlite"));
    const project = store.createProject({ name: "test", rootPath: projectRoot });
    const bridge = { request: async (method: string) => method === "hooks/list" ? { data: [{ hooks: [
      { key: "local", currentHash: "hash-1", sourcePath: manifest, command: "echo safe", eventName: "PreToolUse", handlerType: "command", enabled: true, trustStatus: "untrusted" },
      { key: "global", currentHash: "hash-2", sourcePath: globalManifest, command: "echo secret", eventName: "Stop", handlerType: "command", enabled: true, trustStatus: "untrusted" }
    ], warnings: [], errors: [] }] } : {} } as unknown as CodexBridge;
    const app = Fastify();
    try {
      registerRoutes(app, bridge, store, { backgroundIndexing: false });
      const listed = await app.inject({ method: "GET", url: `/api/projects/${project.id}/hooks` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().data.hooks[0]).toMatchObject({ key: "local", command: "echo safe", trustable: true });
      expect(JSON.stringify(listed.json())).not.toContain("secret");
      const stale = await app.inject({ method: "POST", url: `/api/projects/${project.id}/hooks/trust`, payload: { key: "local", currentHash: "old", trusted: true } });
      const global = await app.inject({ method: "POST", url: `/api/projects/${project.id}/hooks/trust`, payload: { key: "global", currentHash: "hash-2", trusted: true } });
      expect([stale.statusCode, global.statusCode]).toEqual([400, 400]);
      const accepted = await app.inject({ method: "POST", url: `/api/projects/${project.id}/hooks/trust`, payload: { key: "local", currentHash: "hash-1", trusted: true } });
      expect(accepted.statusCode).toBe(200);
      expect(store.getProjectHookTrust("admin", project.id).get("local")).toBe("hash-1");
    } finally { await app.close(); store.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
  });
});
