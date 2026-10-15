import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertRepositoryWithinProject, createManagedWorktree, discoverGitRepositories, removeManagedWorktree } from "./worktree.js";

const run = promisify(execFile);
describe("managed Git worktrees", () => {
  it("creates an independent branch outside the source and rejects nested project paths", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codex-worktree-test-"));
    const source = path.join(temporary, "source");
    const parent = path.join(temporary, "managed");
    await fs.mkdir(source);
    try {
      await run("git", ["init"], { cwd: source });
      await run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"], { cwd: source });
      const token = "12345678-1234-1234-1234-123456789abc";
      const created = await createManagedWorktree(source, parent, token);
      expect(created.branch).toBe(`codex-web/${token}`);
      expect(created.rootPath).toBe(path.join(parent, token));
      expect((await run("git", ["branch", "--show-current"], { cwd: created.rootPath })).stdout.trim()).toBe(created.branch);
      await fs.mkdir(path.join(source, "nested"));
      await expect(createManagedWorktree(path.join(source, "nested"), parent, "22222222-2222-2222-2222-222222222222"))
        .rejects.toThrow("仓库根目录");
      await removeManagedWorktree(source, created.rootPath);
      await expect(fs.stat(created.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});

describe("workspace Git discovery", () => {
  it("finds nested repositories without crossing symlinks or allowing outside paths", async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "codex-git-discovery-"));
    const workspace = path.join(temporary, "workspace");
    const nested = path.join(workspace, "project");
    const outside = path.join(temporary, "outside");
    try {
      await fs.mkdir(nested, { recursive: true });
      await fs.mkdir(outside);
      await run("git", ["init"], { cwd: nested });
      await run("git", ["init"], { cwd: outside });
      await fs.symlink(outside, path.join(workspace, "outside-link"));
      expect(await discoverGitRepositories(workspace)).toEqual([nested]);
      expect(assertRepositoryWithinProject(workspace, nested)).toBe(nested);
      expect(() => assertRepositoryWithinProject(workspace, path.join(workspace, "outside-link"))).toThrow("不属于");
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
});
