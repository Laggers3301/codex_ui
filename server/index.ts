import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import zlib from "node:zlib";
import multipart from "@fastify/multipart";
import compress from "@fastify/compress";
import Fastify from "fastify";
import { CodexBridge } from "./codexBridge.js";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import { authenticatedUserFromHeaders, changeUserPassword, clearSessionCookie, createSessionCookie, verifyCredentials } from "./auth.js";
import { serverConfig } from "./config.js";
import { ProjectStore } from "./db.js";
import { registerRoutes } from "./routes.js";
import { attachSocketServer } from "./socket.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const gzipExtensions = new Set([".js", ".css", ".json", ".svg"]);

function gzipVariant(filePath: string): string {
  const gzipPath = `${filePath}.gz`;
  const sourceStat = fs.statSync(filePath);
  const gzipStat = fs.existsSync(gzipPath) ? fs.statSync(gzipPath) : undefined;
  if (!gzipStat || gzipStat.mtimeMs < sourceStat.mtimeMs) {
    const temporaryPath = `${gzipPath}.${process.pid}.tmp`;
    const compressed = zlib.gzipSync(fs.readFileSync(filePath), {
      level: zlib.constants.Z_BEST_COMPRESSION
    });
    fs.writeFileSync(temporaryPath, compressed);
    fs.renameSync(temporaryPath, gzipPath);
  }
  return gzipPath;
}

const app = Fastify({ logger: true });
await app.register(compress, { global: true, threshold: 1024 });

function requestPath(url: string | undefined): string {
  return new URL(url ?? "/", "http://localhost").pathname;
}

function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/api/auth/login" || pathname === "/logout" || pathname === "/favicon.ico";
}

function wantsHtml(request: { method: string; headers: { accept?: string } }): boolean {
  return request.method === "GET" || request.method === "HEAD" || request.headers.accept?.includes("text/html") === true;
}

function shouldRenewSessionCookie(pathname: string): boolean {
  return pathname !== "/api/auth/logout" && pathname !== "/api/auth/change-password";
}

app.addHook("onRequest", async (request, reply) => {
  const pathname = requestPath(request.raw.url);
  if (isPublicPath(pathname)) {
    return;
  }

  // A peer can request only its local leaderboard snapshot with the shared
  // internal token; browser login cookies never leave this machine.
  const peerToken = String(request.headers["x-codex-leaderboard-peer-token"] ?? "");
  if (
    pathname === "/api/codex/leaderboard"
    && serverConfig.leaderboardPeerToken
    && peerToken === serverConfig.leaderboardPeerToken
    && new URL(request.raw.url ?? "/", "http://localhost").searchParams.get("local") === "true"
  ) {
    return;
  }

  const username = authenticatedUserFromHeaders(request.headers);
  if (username) {
    // Sliding long-lived session: every normal request renews the cookie.
    if (username !== "auth-disabled" && shouldRenewSessionCookie(pathname)) {
      reply.header("Set-Cookie", createSessionCookie(username));
    }
    return;
  }

  if (pathname.startsWith("/api") || pathname.startsWith("/ws") || !wantsHtml(request)) {
    return reply.code(401).send({ error: "Authentication required." });
  }
  return reply.redirect("/login", 302);
});

const store = new ProjectStore();
const bridge = serverConfig.accountPoolFile
  ? AccountPoolBridge.fromFile(serverConfig.accountPoolFile)
  : new CodexBridge();

await app.register(multipart, {
  limits: {
    fileSize: 64 * 1024 * 1024,
    files: 12
  }
});

registerRoutes(app, bridge as CodexBridge, store);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}

function authLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; min-width: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: safe center; padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); overflow: auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: linear-gradient(135deg,#eef2ff,#f8fafc 45%,#ecfeff); color: #111827; }
    main { width: min(100%, 460px); min-width: 0; background: rgba(255,255,255,.96); border: 1px solid #e5e7eb; border-radius: 18px; padding: clamp(20px, 6vw, 30px); box-shadow: 0 18px 50px rgba(15,23,42,.12); }
    h1 { margin: 0 0 8px; font-size: 26px; letter-spacing: -0.03em; }
    p { color: #4b5563; line-height: 1.6; margin: 8px 0 0; }
    label { display: block; margin-top: 18px; font-weight: 700; color: #1f2937; }
    input { width: 100%; min-width: 0; margin-top: 7px; padding: 11px 12px; border: 1px solid #d1d5db; border-radius: 10px; font-size: 16px; outline: none; }
    input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.14); }
    button { margin-top: 24px; width: 100%; padding: 12px 14px; border: 0; border-radius: 10px; background: #2563eb; color: white; font-size: 15px; font-weight: 800; cursor: pointer; }
    button.secondary { background: #f3f4f6; color: #111827; }
    a { color: #2563eb; font-weight: 700; text-decoration: none; }
    .links { display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; margin-top: 18px; }
    .msg { margin-top: 16px; padding: 10px 12px; border-radius: 10px; display: none; font-size: 14px; }
    .ok { background: #ecfdf5; color: #065f46; display: block; }
    .err { background: #fef2f2; color: #991b1b; display: block; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 5px; }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

app.get("/login", async (_request, reply) => {
  const page = authLayout("登录 Codex Remote", `<h1>登录 Codex Remote</h1>
    <p>加入 ZeroTier 网络后，用自己的姓名登录。初始密码是 <code>ls</code>，登录后可以修改密码。</p>
    <form id="form">
      <label>用户名 / 姓名</label>
      <input name="username" autocomplete="username" required autofocus />
      <label>密码</label>
      <input name="password" type="password" autocomplete="current-password" required />
      <button type="submit">登录</button>
    </form>
    <div id="msg" class="msg"></div>
    <script>
      const form = document.getElementById('form');
      const msg = document.getElementById('msg');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        msg.className = 'msg';
        const data = Object.fromEntries(new FormData(form).entries());
        const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          msg.className = 'msg err';
          msg.textContent = result.error || '登录失败。';
          return;
        }
        window.location.href = '/';
      });
    </script>`);
  return reply.type("text/html; charset=utf-8").send(page);
});

app.post("/api/auth/login", async (request, reply) => {
  const body = request.body as { username?: unknown; password?: unknown } | undefined;
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!username || !verifyCredentials(username, password)) {
    return reply.code(401).send({ error: "用户名或密码不正确。首次登录请使用自己的姓名和初始密码 ls。" });
  }
  return reply.header("Set-Cookie", createSessionCookie(username)).send({ ok: true, username });
});

app.post("/api/auth/logout", async (_request, reply) => {
  return reply.header("Set-Cookie", clearSessionCookie()).send({ ok: true });
});

app.get("/logout", async (_request, reply) => {
  return reply.header("Set-Cookie", clearSessionCookie()).redirect("/login", 302);
});

app.get("/api/auth/me", async (request) => ({
  data: {
    username: authenticatedUserFromHeaders(request.headers)
  }
}));

app.post("/api/auth/change-password", async (request, reply) => {
  const username = authenticatedUserFromHeaders(request.headers);
  if (!username) {
    return reply.code(401).send({ error: "Authentication required." });
  }
  const body = request.body as { currentPassword?: unknown; newPassword?: unknown; confirmPassword?: unknown } | undefined;
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  const confirmPassword = typeof body?.confirmPassword === "string" ? body.confirmPassword : "";
  if (newPassword !== confirmPassword) {
    return reply.code(400).send({ error: "两次新密码不一致。" });
  }
  try {
    changeUserPassword(username, currentPassword, newPassword);
    return reply.header("Set-Cookie", clearSessionCookie()).send({ ok: true, username });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/change-password", async (request, reply) => {
  const username = authenticatedUserFromHeaders(request.headers) ?? "";
  const safeUsername = escapeHtml(username);
  const page = authLayout("修改 Codex Remote 密码", `<h1>修改密码</h1>
    <p>当前登录用户：<code>${safeUsername}</code></p>
    <p>初始密码是 <code>ls</code>。修改后请用新密码重新登录。</p>
    <form id="form">
      <label>当前密码</label>
      <input name="currentPassword" type="password" autocomplete="current-password" required />
      <label>新密码</label>
      <input name="newPassword" type="password" autocomplete="new-password" required />
      <label>确认新密码</label>
      <input name="confirmPassword" type="password" autocomplete="new-password" required />
      <button type="submit">保存新密码</button>
    </form>
    <div id="msg" class="msg"></div>
    <div class="links"><a href="/">返回 Codex</a><a href="/logout">退出登录</a></div>
    <script>
      const form = document.getElementById('form');
      const msg = document.getElementById('msg');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        msg.className = 'msg';
        const data = Object.fromEntries(new FormData(form).entries());
        if (data.newPassword !== data.confirmPassword) {
          msg.className = 'msg err';
          msg.textContent = '两次新密码不一致。';
          return;
        }
        const response = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: data.currentPassword, newPassword: data.newPassword, confirmPassword: data.confirmPassword }) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          msg.className = 'msg err';
          msg.textContent = result.error || '修改失败。';
          return;
        }
        window.location.href = '/logout';
      });
    </script>`);
  return reply.type("text/html; charset=utf-8").send(page);
});

app.setNotFoundHandler((request, reply) => {
  if (request.raw.url?.startsWith("/api") || request.raw.url?.startsWith("/ws")) {
    return reply.code(404).send({ error: "Not found." });
  }
  if (!fs.existsSync(distDir)) {
    return reply.code(404).send({ error: "Frontend has not been built. Run npm run dev for Vite." });
  }

  const requestPath = new URL(request.raw.url ?? "/", "http://localhost").pathname;
  const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const candidate = path.resolve(distDir, relativePath);
  const safeCandidate = candidate === distDir || candidate.startsWith(`${distDir}${path.sep}`);
  const filePath = safeCandidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(distDir, "index.html");
  const extension = path.extname(filePath);
  if (extension === ".html" || path.basename(filePath) === "sw.js") {
    reply.header("Cache-Control", "no-store");
  } else {
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
  }

  let responsePath = filePath;
  if (gzipExtensions.has(extension)) {
    reply.header("Vary", "Accept-Encoding");
    const acceptEncoding = String(request.headers["accept-encoding"] ?? "");
    if (/(?:^|,)\s*gzip\s*(?:,|$)/i.test(acceptEncoding)) {
      try {
        responsePath = gzipVariant(filePath);
        reply.header("Content-Encoding", "gzip");
      } catch (error) {
        request.log.warn({ error, filePath }, "failed to prepare gzip static asset; sending original file");
      }
    }
  }
  reply.header("Content-Length", fs.statSync(responsePath).size);
  return reply.type(mimeTypes[extension] ?? "application/octet-stream").send(fs.createReadStream(responsePath));
});

attachSocketServer(app.server, bridge as CodexBridge, store);

let shuttingDown = false;
async function shutdownServer(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    app.log.info({ signal }, "Shutting down Codex Web Console");
    bridge.stop();
    store.close();
    process.exit(0);
  } catch (caught) {
    app.log.error({ signal, error: caught instanceof Error ? caught.message : String(caught) }, "Shutdown failed");
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdownServer("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdownServer("SIGTERM");
});

await bridge.start();
await app.listen({ host: serverConfig.host, port: serverConfig.port });
