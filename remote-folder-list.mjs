import fs from "node:fs/promises";
import path from "node:path";

const [workspace, root, relative = ""] = process.argv.slice(2);
function inside(base, value) {
  const difference = path.relative(base, value);
  return difference === "" || (difference !== ".." && !difference.startsWith(`..${path.sep}`) && !path.isAbsolute(difference));
}

try {
  const mounts = await fs.readFile("/proc/self/mountinfo", "utf8");
  const mounted = mounts.split("\n").some((line) => {
    const field = line.split(" ")[4];
    return field?.replace(/\\([0-7]{3})/g, (_, digits) => String.fromCharCode(parseInt(digits, 8))) === root;
  });
  if (!mounted) throw new Error("目录已断开，请点击刷新或重试恢复连接。");
  const workspaceReal = await fs.realpath(workspace);
  const rootReal = await fs.realpath(root);
  const target = path.resolve(root, relative);
  const targetReal = relative ? await fs.realpath(target) : rootReal;
  if (!inside(workspaceReal, rootReal) || !inside(rootReal, targetReal) || !inside(root, target)) {
    throw new Error("路径或链接超出了已连接目录。");
  }
  const directory = await fs.opendir(targetReal);
  const entries = [];
  let truncated = false;
  for await (const entry of directory) {
    if (entries.length >= 1000) { truncated = true; break; }
    entries.push({ name: entry.name, path: path.join(relative, entry.name),
      kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" });
  }
  entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
  console.log(JSON.stringify({ entries, truncated }));
} catch (error) {
  const messages = { ENOENT: "目录不存在，可能已被移动。", EACCES: "没有读取此目录的权限。", ENOTCONN: "远程连接已断开，请重新连接。", ENOTDIR: "所选路径不是目录。" };
  console.log(JSON.stringify({ error: messages[error.code] ?? error.message }));
}
