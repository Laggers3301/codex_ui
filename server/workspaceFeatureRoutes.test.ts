import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";

describe("workspace feature routes", () => {
  it("discovers nested Git repos and appends an official project Hook without replacing existing config", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-routes-"));
    const userRoot = path.join(temporary, "users", "admin");
    const projectRoot = path.join(userRoot, "project");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".codex"));
    const hookFile = path.join(projectRoot, ".codex", "hooks.json");
    fs.writeFileSync(hookFile, JSON.stringify({ description: "existing", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo old" }] }] } }));
    const store = new ProjectStore(path.join(temporary, "test.sqlite"));
    const project = store.createProject({ name: "test", rootPath: projectRoot });
    const bridge = { request: async () => ({}) } as unknown as CodexBridge;
    const app = Fastify();
    vi.stubEnv("CODEX_WEB_USER_WORKSPACE_ROOT", path.join(temporary, "users"));
    vi.resetModules();
    try {
      const { registerRoutes } = await import("./routes.js");
      registerRoutes(app, bridge, store, { backgroundIndexing: false });
      const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/hooks`, payload: { eventName: "Stop", command: "git diff --check" } });
      expect(created.statusCode).toBe(201);
      const config = JSON.parse(fs.readFileSync(hookFile, "utf8"));
      expect(config.description).toBe("existing");
      expect(config.hooks.Stop.map((item: { hooks: Array<{ command: string }> }) => item.hooks[0].command)).toEqual(["echo old", "git diff --check"]);
      const nested = path.join(projectRoot, "repo");
      fs.mkdirSync(nested);
      execFileSync("git", ["init"], { cwd: nested, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"], { cwd: nested, stdio: "ignore" });
      const listed = await app.inject({ method: "GET", url: `/api/projects/${project.id}/git-repositories` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().data).toEqual([{ rootPath: nested, name: "repo" }]);
      const worktree = await app.inject({ method: "POST", url: `/api/projects/${project.id}/worktrees`, payload: { repositoryPath: nested } });
      expect(worktree.statusCode).toBe(201);
      expect(worktree.json().repositoryRoot).toBe(nested);
      expect(fs.existsSync(worktree.json().data.rootPath)).toBe(true);
    } finally {
      await app.close(); store.close(); vi.unstubAllEnvs(); vi.resetModules();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
