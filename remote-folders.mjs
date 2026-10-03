import http from "node:http";
import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const worker = fileURLToPath(new URL("./remote-folder-list.mjs", import.meta.url));
const controller = fileURLToPath(new URL("./remote-folder-control.py", import.meta.url));
const pending = new Map();

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

const validThreadId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export async function readRemoteFolders(workspace, threadId = null) {
  if (threadId !== null && !validThreadId(threadId)) {
    throw Object.assign(new Error("对话标识无效。"), { statusCode: 400 });
  }
  const registry = path.join(workspace, ".codex", "remote-folders.json");
  try {
    if (!isWithin(await realpath(workspace), await realpath(registry))) throw new Error("目录记录不属于当前工作区。");
    if ((await stat(registry)).size > 256 * 1024) throw new Error("目录记录过大。");
    const entries = JSON.parse(await readFile(registry, "utf8"));
    if (!Array.isArray(entries) || entries.length > 100) throw new Error("目录记录格式不正确。");
    let selected = !threadId || threadId.startsWith("draft-") ? [] : null;
    const viewsFile = path.join(workspace, ".codex", "remote-folder-views.json");
    try {
      if (!isWithin(await realpath(workspace), await realpath(viewsFile))) throw new Error("对话目录配置不属于当前工作区。");
      if ((await stat(viewsFile)).size > 2 * 1024 * 1024) throw new Error("对话目录配置过大。");
      const views = JSON.parse(await readFile(viewsFile, "utf8"));
      if (!views || Array.isArray(views) || typeof views !== "object") throw new Error("对话目录配置无效。");
      if (threadId && Object.hasOwn(views, threadId)) {
        if (!Array.isArray(views[threadId]) || views[threadId].length > 100 || !views[threadId].every(validThreadId)) throw new Error("对话目录配置无效。");
        selected = views[threadId];
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const ids = new Set();
    return entries.map((entry) => {
      if (!entry || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) || ids.has(entry.id)
        || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 120
        || typeof entry.mount_path !== "string" || !path.isAbsolute(entry.mount_path)
        || !isWithin(workspace, path.resolve(entry.mount_path)) || path.resolve(entry.mount_path) === workspace) {
        throw new Error("目录记录包含无效路径或重复标识。");
      }
      ids.add(entry.id);
      if (entry.thread_ids != null && (!Array.isArray(entry.thread_ids) || entry.thread_ids.length > 1000
        || !entry.thread_ids.every(validThreadId))) throw new Error("目录记录包含无效对话标识。");
      // Legacy unbound mounts are available in the picker, but must never become
      // a new conversation's default directory. Sharing must be explicit.
      if (selected !== null ? !selected.includes(entry.id) : entry.shared !== true && !entry.thread_ids?.includes(threadId)) return null;
      return { id: entry.id, name: entry.name, host: String(entry.host ?? ""), remotePath: String(entry.remote_path ?? ""),
        mountPath: path.resolve(entry.mount_path), readOnly: entry.read_only !== false,
        scope: entry.shared === true ? "account" : "conversation" };
    }).filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function listRemoteFolder(workspace, folder, relativePath = "", coldStart = false) {
  if (typeof relativePath !== "string" || relativePath.length > 4096 || relativePath.includes("\0")
    || path.isAbsolute(relativePath) || !isWithin(folder.mountPath, path.resolve(folder.mountPath, relativePath))) {
    throw new Error("路径必须位于所选远程目录内。");
  }
  // A stalled network filesystem must not occupy the web server's worker pool.
  const key = JSON.stringify([workspace, folder.mountPath, relativePath, coldStart]);
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= 16) throw new Error("正在读取其他目录，请稍后重试。");
  const operation = execute(process.execPath, [worker, workspace, folder.mountPath, relativePath],
    { timeout: coldStart ? 15000 : 8000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 })
    .then(({ stdout }) => {
      const result = JSON.parse(stdout);
      if (result.error) throw new Error(result.error);
      return result;
    }).catch((error) => {
      if (error.killed || error.signal) throw new Error("读取超时，请检查远程连接后重试。");
      throw error;
    }).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}

export async function controlRemoteFolder(workspace, action, payload = {}) {
  if (pending.size >= 16) throw new Error("正在读取其他目录，请稍后重试。");
  const key = JSON.stringify(["control", workspace, action, payload]);
  if (pending.has(key)) return pending.get(key);
  const operation = new Promise((resolve, reject) => {
    const child = execFile("python3", [controller, workspace, action], { timeout: 40000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error(error.killed ? "远程目录操作超时，请重试。" : "无法读取远程目录配置。"));
      try {
        const result = JSON.parse(stdout);
        if (result.error) throw new Error(result.error);
        resolve(result.data);
      } catch (caught) { reject(caught); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  }).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}

async function jsonBody(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("请求格式应为 JSON。"), { statusCode: 415 });
  }
  if (request.headers.origin && new URL(request.headers.origin).host !== request.headers.host) {
    throw Object.assign(new Error("不允许跨站修改目录。"), { statusCode: 403 });
  }
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 16384) throw Object.assign(new Error("目录请求过大。"), { statusCode: 413 });
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error("目录请求无效。"), { statusCode: 400 }); }
}

function signedInUser(request, host, port) {
  return new Promise((resolve, reject) => {
    // Identity comes only from the existing authenticated backend. In particular,
    // neither a local connection nor an x-codex-web-user-id header grants access.
    const headers = {};
    for (const name of ["cookie", "authorization"]) if (request.headers[name]) headers[name] = request.headers[name];
    const upstream = http.get({ host, port, path: "/api/users", headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; if (body.length > 64 * 1024) response.destroy(); });
      response.on("error", reject);
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw Object.assign(new Error("请先登录。"), { statusCode: 401 });
          const result = JSON.parse(body);
          const user = result.defaultUserId;
          if (!result.lockedToLoginUser || typeof user !== "string" || !user || user === "." || user === ".."
            || /[\x00-\x1f/\\]/.test(user) || !result.data?.some((entry) => entry.id === user)) {
            throw Object.assign(new Error("无法确认当前登录用户。"), { statusCode: 401 });
          }
          resolve(user);
        } catch (error) { reject(error); }
      });
    });
    upstream.setTimeout(5000, () => upstream.destroy(new Error("登录服务暂时不可用。")));
    upstream.on("error", reject);
  });
}

export function createRemoteFoldersHandler({ upstreamHost, upstreamPort, workspaceRoot }) {
  return async (request, response) => {
    let ownerUserId;
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store",
        Vary: "Cookie, Authorization, x-codex-web-user-id" });
      response.end(JSON.stringify({ ...body, ownerUserId }));
    };
    try {
      if (!["GET", "POST"].includes(request.method)) return send(405, { error: "不支持的目录操作。" });
      const user = await signedInUser(request, upstreamHost, upstreamPort);
      ownerUserId = user;
      if (request.headers["x-codex-web-user-id"] && request.headers["x-codex-web-user-id"] !== user) {
        return send(403, { error: "页面账号与登录账号不一致，请刷新网页后重试。" });
      }
      const workspace = path.resolve(workspaceRoot, user);
      if (!isWithin(path.resolve(workspaceRoot), workspace)) return send(403, { error: "工作区不可用。" });
      if (await realpath(workspace) !== path.join(await realpath(workspaceRoot), user)) {
        return send(403, { error: "工作区不属于当前登录账号。" });
      }
      const url = new URL(request.url, "http://localhost");
      if (request.method === "POST") {
        const action = /^\/api\/remote-folders\/(browse|attach|transfer)$/.exec(url.pathname)?.[1];
        const folderAction = /^\/api\/remote-folders\/([a-zA-Z0-9_-]+)\/(close|reconnect)$/.exec(url.pathname);
        if (!action && !folderAction) return send(405, { error: "不支持的目录操作。" });
        const payload = await jsonBody(request);
        if ((action === "attach" || action === "transfer" || folderAction) && !validThreadId(payload.threadId)) return send(400, { error: "对话标识无效。" });
        if (folderAction?.[2] === "reconnect") {
          const folders = await readRemoteFolders(workspace, payload.threadId);
          const folder = folders.find(folder => folder.id === folderAction[1]);
          if (!folder) return send(404, { error: "未找到此对话可用的远程目录。" });
          const restored = await controlRemoteFolder(workspace, "reconnect", { threadId: payload.threadId, folderId: folder.id });
          // The first FUSE read after reconnect can be slower. Keep the progress
          // visible until the actual directory is readable, not merely mounted.
          await listRemoteFolder(workspace, folder, "", true);
          return send(200, { data: restored });
        }
        return send(200, { data: await controlRemoteFolder(workspace, action ?? folderAction[2], folderAction ? { threadId: payload.threadId, folderId: folderAction[1] } : payload) });
      }
      if (url.pathname === "/api/remote-folders/catalog") return send(200, { data: await controlRemoteFolder(workspace, "catalog") });
      const folders = await readRemoteFolders(workspace, url.searchParams.get("threadId"));
      if (url.pathname === "/api/remote-folders") return send(200, { data: folders, workspacePath: workspace });
      const match = /^\/api\/remote-folders\/([a-zA-Z0-9_-]+)\/entries$/.exec(url.pathname);
      const folder = match && folders.find((entry) => entry.id === match[1]);
      if (!folder) return send(404, { error: "未找到此对话可用的远程目录。" });
      return send(200, { data: await listRemoteFolder(workspace, folder, url.searchParams.get("path") ?? "") });
    } catch (error) {
      return send(error.statusCode ?? 503, { error: error.message || "暂时无法读取远程目录。" });
    }
  };
}
