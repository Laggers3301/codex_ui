import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execGit = promisify(execFile);

export async function discoverGitRepositories(projectRoot: string, maxDepth = 4): Promise<string[]> {
  const root = fs.realpathSync(projectRoot);
  const found: string[] = [];
  const ignored = new Set(["node_modules", ".next", "dist", "build", ".venv", "venv", "__pycache__", ".cache", ".codex-web-worktrees"]);
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (found.length >= 80) return;
    if (fs.existsSync(path.join(directory, ".git"))) {
      try {
        const repo = (await execGit("git", ["rev-parse", "--show-toplevel"], { cwd: directory, timeout: 10_000 })).stdout.trim();
        if (fs.realpathSync(repo) === directory) found.push(directory);
      } catch { /* A malformed .git entry is not a selectable repository. */ }
      return;
    }
    if (depth >= maxDepth) return;
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ignored.has(entry.name)) continue;
      await visit(path.join(directory, entry.name), depth + 1);
      if (found.length >= 80) break;
    }
  };
  await visit(root, 0);
  return found.sort((a, b) => a.localeCompare(b));
}

export function assertRepositoryWithinProject(projectRoot: string, repositoryPath: string): string {
  const root = fs.realpathSync(projectRoot);
  const repo = fs.realpathSync(repositoryPath);
  if (repo !== root && !repo.startsWith(`${root}${path.sep}`)) {
    throw new Error("Git 仓库不属于当前工作区。");
  }
  return repo;
}

export async function createManagedWorktree(sourceRoot: string, parent: string, token: string): Promise<{ rootPath: string; branch: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw new Error("Invalid worktree id.");
  const root = (await execGit("git", ["rev-parse", "--show-toplevel"], { cwd: sourceRoot, timeout: 10_000 })).stdout.trim();
  if (fs.realpathSync(root) !== fs.realpathSync(sourceRoot)) {
    throw new Error("请先选择 Git 仓库根目录作为工作区，再创建独立工作树。");
  }
  const rootPath = path.join(parent, token);
  const branch = `codex-web/${token}`;
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  await execGit("git", ["worktree", "add", "-b", branch, rootPath, "HEAD"], { cwd: root, timeout: 60_000 });
  return { rootPath, branch };
}

export async function removeManagedWorktree(sourceRoot: string, worktreePath: string): Promise<void> {
  await execGit("git", ["worktree", "remove", worktreePath], { cwd: sourceRoot, timeout: 30_000 });
}
