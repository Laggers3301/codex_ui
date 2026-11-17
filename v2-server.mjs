import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRemoteFoldersHandler } from "./remote-folders.mjs";
import { createClientDiagnosticsHandler } from './client-diagnostics.mjs';

const host = "0.0.0.0";
const port = Number(process.env.CODEX_V2_PORT ?? 4575);
const upstreamHost = "127.0.0.1";
const upstreamPort = Number(process.env.CODEX_V2_UPSTREAM_PORT ?? 4576);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const sessionCookieName = process.env.CODEX_V2_SESSION_COOKIE_NAME?.trim() || "codex_remote_session_4575";
const upstreamRetryDelaysMs = [100, 250, 500, 1_000, 2_000, 3_000];
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 32 });
const remoteFolders = createRemoteFoldersHandler({ upstreamHost, upstreamPort,
  workspaceRoot: process.env.CODEX_WEB_USER_WORKSPACE_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..") });
const clientDiagnostics = createClientDiagnosticsHandler({ upstreamHost, upstreamPort,
  file: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/frontend-diagnostics/events.jsonl') });

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"]
]);

function hasSessionCookie(request) {
  return (request.headers.cookie ?? "").split(";").some((item) => item.trim().startsWith(`${sessionCookieName}=`));
}

function isPublicPath(requestUrl) {
  const pathname = new URL(requestUrl ?? "/", "http://localhost").pathname;
  return pathname === "/login" || pathname === "/api/auth/login";
}

function requireAuthorization(request, response) {
  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1") return true;
  if (request.headers.authorization || hasSessionCookie(request) || isPublicPath(request.url)) return true;
  if (new URL(request.url ?? "/", "http://localhost").pathname === "/") {
    response.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
    response.end();
    return false;
  }
  response.writeHead(401, {
    "WWW-Authenticate": "Basic realm=\"Codex Web V2\"",
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end("Authentication required.");
  return false;
}

function proxyHttp(request, response) {
  const retryable = request.method === "GET" || request.method === "HEAD";

  const attempt = (attemptIndex = 0) => {
    if (request.destroyed || response.destroyed || response.writableEnded) return;
    const upstream = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `${upstreamHost}:${upstreamPort}` },
      agent: upstreamAgent
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      const retryDelay = upstreamRetryDelaysMs[attemptIndex];
      if (retryable && retryDelay !== undefined && !response.headersSent && !response.writableEnded) {
        setTimeout(() => attempt(attemptIndex + 1), retryDelay);
        return;
      }
      if (!response.headersSent) {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end(`Codex backend unavailable: ${error.message}`);
      } else {
        response.destroy(error);
      }
    });
    if (retryable) upstream.end();
    else request.pipe(upstream);
  };

  attempt();
}

const brotli = promisify(brotliCompress), gzipAsync = promisify(gzip);
const compressibleTypes = new Set([".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".svg"]);
// Compressed bodies are computed once per (file, mtime, size, encoding) off the event
// loop (zlib's thread pool) and kept in a small LRU. Hashed assets never change, so the
// 2.4 MB entry script costs one ~0.3 s brotli pass per deploy, then every client gets
// ~600 KB. Compression sits behind Caddy, which leaves an already-encoded body alone.
const compressedCache = new Map(), compressing = new Map();
let compressedBytes = 0;
const compressedLimit = 96 * 1024 * 1024;

function chooseEncoding(header) {
  const accepted = String(header ?? "").toLowerCase();
  if (/(^|[\s,])br(\s*;|\s*,|\s*$)/.test(accepted) && !/br\s*;\s*q=0(\.0+)?(\s*,|$)/.test(accepted)) return "br";
  if (/(^|[\s,])gzip(\s*;|\s*,|\s*$)/.test(accepted) && !/gzip\s*;\s*q=0(\.0+)?(\s*,|$)/.test(accepted)) return "gzip";
  return null;
}

async function compressedBody(filePath, info, encoding) {
  const key = `${filePath}|${info.mtimeMs}|${info.size}|${encoding}`;
  const hit = compressedCache.get(key);
  if (hit) { compressedCache.delete(key); compressedCache.set(key, hit); return hit; }
  let job = compressing.get(key);
  if (!job) {
    job = (async () => {
      const chunks = [];
      for await (const chunk of createReadStream(filePath)) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const body = encoding === "br"
        ? await brotli(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 7, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
        : await gzipAsync(raw, { level: 8 });
      compressedCache.set(key, body); compressedBytes += body.length;
      while (compressedBytes > compressedLimit && compressedCache.size > 1) {
        const [oldest, value] = compressedCache.entries().next().value;
        compressedCache.delete(oldest); compressedBytes -= value.length;
      }
      return body;
    })().finally(() => compressing.delete(key));
    compressing.set(key, job);
  }
  return job;
}

async function staticFileFor(url) {
  let pathname;
  // A malformed escape (e.g. "/%") must be a normal miss, never an exception.
  try { pathname = decodeURIComponent(new URL(url, "http://localhost").pathname); } catch { return null; }
  if (pathname.includes("\0")) return null;
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  const info = await stat(target).catch(() => null);
  return info?.isFile() ? { target, info } : null;
}

async function sendStatic(request, response, filePath, info) {
  const extension = path.extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": mime.get(extension) ?? "application/octet-stream",
    "Cache-Control": [".html", ".webmanifest"].includes(extension) || ["sw.js", "loader.mjs"].includes(path.basename(filePath)) ? "no-store" : "public, max-age=31536000, immutable"
  };
  const head = request.method === "HEAD";
  if (compressibleTypes.has(extension)) {
    headers.Vary = "Accept-Encoding";
    const encoding = info.size >= 1024 ? chooseEncoding(request.headers["accept-encoding"]) : null;
    if (encoding) {
      const body = await compressedBody(filePath, info, encoding);
      headers["Content-Encoding"] = encoding; headers["Content-Length"] = body.length;
      response.writeHead(200, headers);
      response.end(head ? undefined : body);
      return;
    }
  }
  headers["Content-Length"] = info.size;
  response.writeHead(200, headers);
  if (head) { response.end(); return; }
  // Stream large files instead of holding each one in memory per request.
  pipeline(createReadStream(filePath), response, () => {});
}

async function handleRequest(request, response) {
  if (request.url === "/__v2_logout") {
    response.writeHead(302, {
      Location: "/logout",
      "Cache-Control": "no-store",
      "Clear-Site-Data": "\"cache\", \"storage\""
    });
    response.end();
    return;
  }
  if (!requireAuthorization(request, response)) return;
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === '/api/client-diagnostics') {
    await clientDiagnostics(request, response);
    return;
  }
  if (pathname === "/api/remote-folders" || pathname.startsWith("/api/remote-folders/")) {
    await remoteFolders(request, response);
    return;
  }
  const file = await staticFileFor(request.url ?? "/");
  if (file) {
    await sendStatic(request, response, file.target, file.info);
    return;
  }
  proxyHttp(request, response);
}

// One bad request must never take the whole front door down: an async rejection in the
// handler used to be an unhandled rejection, i.e. a process exit.
const server = http.createServer((request, response) => {
  handleRequest(request, response).catch(error => {
    console.error("request failed", request.method, request.url?.slice(0, 200), error?.message ?? error);
    if (!response.headersSent) { response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end("Bad request"); }
    else response.destroy();
  });
});

server.on("upgrade", (request, socket, head) => {
  if (!request.headers.authorization && !hasSessionCookie(request)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"Codex Web V2\"\r\n\r\n");
    return;
  }
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    let handshake = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      handshake += `${name}: ${name.toLowerCase() === "host" ? `${upstreamHost}:${upstreamPort}` : value}\r\n`;
    }
    upstream.write(`${handshake}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(port, host, () => {
  console.log(`Codex Web V2 listening on http://${host}:${port}`);
});
