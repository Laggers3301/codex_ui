import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { isProjectLocalHook, scopedHookTrustConfig } from "./hookTrust.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("project-scoped Hook trust", () => {
  it("rejects hooks outside the project, including symlink escapes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-scope-")); roots.push(root);
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".codex"), { recursive: true });
    const local = path.join(project, ".codex", "hooks.json");
    const outside = path.join(root, "outside.json");
    fs.writeFileSync(local, "{}"); fs.writeFileSync(outside, "{}");
    const escape = path.join(project, ".codex", "escape.json");
    fs.symlinkSync(outside, escape);
    expect(isProjectLocalHook(project, local)).toBe(true);
    expect(isProjectLocalHook(project, outside)).toBe(false);
    expect(isProjectLocalHook(project, escape)).toBe(false);
  });

  it("passes only the owning user's current exact hash into thread config", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-trust-")); roots.push(root);
    const projectRoot = path.join(root, "project");
    fs.mkdirSync(path.join(projectRoot, ".codex"), { recursive: true });
    const manifest = path.join(projectRoot, ".codex", "hooks.json"); fs.writeFileSync(manifest, "{}");
    const store = new ProjectStore(path.join(root, "store.sqlite"));
    try {
      const project = store.createProject({ name: "test", rootPath: projectRoot });
      store.setProjectHookTrust("admin", project.id, "local:hook", "hash-1");
      const bridge = { request: async () => ({ data: [{ hooks: [
        { key: "local:hook", currentHash: "hash-1", sourcePath: manifest },
        { key: "global:hook", currentHash: "hash-1", sourcePath: path.join(root, "outside.json") }
      ] }] }) } as unknown as CodexBridge;
      expect(await scopedHookTrustConfig(bridge, store, "admin", project)).toEqual({ "hooks.state": { "local:hook": { trusted_hash: "hash-1" } } });
      store.setProjectHookTrust("admin", project.id, "local:hook", "old-hash");
      expect(await scopedHookTrustConfig(bridge, store, "admin", project)).toEqual({});
      const other = store.createUser("other");
      expect(await scopedHookTrustConfig(bridge, store, other.id, project)).toEqual({});
    } finally { store.close(); }
  });
});
