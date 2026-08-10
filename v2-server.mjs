import http from "node:http";
import net from "node:net";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const host = "0.0.0.0";
const port = 4574;
const upstreamHost = "127.0.0.1";
const upstreamPort = 4573;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"]
]);

function requireAuthorization(request, response) {
  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1") return true;
  if (request.headers.authorization) return true;
  response.writeHead(401, {
    "WWW-Authenticate": "Basic realm=\"Codex Web V2\"",
    "Content-Type": "text/plain; charset=utf-8"
  });
  response.end("Authentication required.");
  return false;
}

function proxyHttp(request, response) {
  const upstream = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: `${upstreamHost}:${upstreamPort}` }
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Codex backend unavailable: ${error.message}`);
  });
  request.pipe(upstream);
}

async function staticFileFor(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  const info = await stat(target).catch(() => null);
  return info?.isFile() ? target : null;
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/__v2_logout") {
    response.writeHead(401, {
      "WWW-Authenticate": "Basic realm=\"Codex Web V2 signed out\"",
      "Clear-Site-Data": "\"cache\", \"cookies\", \"storage\"",
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end("Signed out. Close this tab or sign in again.");
    return;
  }
  if (!requireAuthorization(request, response)) return;
  const filePath = await staticFileFor(request.url ?? "/");
  if (filePath) {
    const body = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mime.get(extension) ?? "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
    });
    response.end(body);
    return;
  }
  proxyHttp(request, response);
});

server.on("upgrade", (request, socket, head) => {
  if (!request.headers.authorization) {
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
