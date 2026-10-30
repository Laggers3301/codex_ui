import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTlsServer } from "node:tls";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "./auth.js";
import { HostNetworkProbe, runHttpsProbe, type HttpsProbeOutput } from "./hostNetwork.js";
import { registerHostResourceRoutes } from "./hostResources.js";

let root: string, key: Buffer, cert: Buffer;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "host-network-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem"), "-subj", "/CN=www.google.com", "-addext", "subjectAltName=DNS:www.google.com,IP:127.0.0.1", "-days", "1"], { stdio: "ignore" });
  key = readFileSync(path.join(root, "key.pem")); cert = readFileSync(path.join(root, "cert.pem"));
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

async function proxyFixture(options: { mode?: "hang" | "hang_tls" | "reject" | "tls"; proxyHttps?: boolean; targetStatus?: number } = {}) {
  const sockets = new Set<Socket>(), connections: Array<{ target?: string; authorization?: string }> = [];
  const mode = options.mode ?? "tls";
  const proxy = options.proxyHttps ? createHttpsServer({ key, cert }) : createServer();
  const target = createTlsServer({ key, cert }, socket => {
    socket.once("data", data => {
      expect(data.toString()).toMatch(/^HEAD \/ HTTP\/1\.1/);
      socket.end(`HTTP/1.1 ${options.targetStatus ?? 200} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
  });
  target.on("tlsClientError", () => {});
  proxy.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("end", () => socket.end()); socket.once("close", () => sockets.delete(socket)); });
  proxy.on("connect", (request, socket) => {
    connections.push({ target: request.url, authorization: request.headers["proxy-authorization"] });
    if (mode === "hang") return;
    if (mode === "reject") { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); return; }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (mode === "tls") target.emit("connection", socket);
    else socket.resume();
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as AddressInfo).port;
  return { url: `${options.proxyHttps ? "https" : "http"}://127.0.0.1:${port}`, sockets, connections,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); target.close(); } };
}
const success: HttpsProbeOutput = { status: "reachable", message: "通过服务代理的 HTTPS 连接成功（HTTP 200）。", httpStatus: 200, proxyStatus: 200 };

describe("manual HTTPS connectivity through the configured proxy", () => {
  it("does not fall back to a direct connection when the proxy is absent or invalid", async () => {
    expect(await runHttpsProbe({})).toMatchObject({ status: "proxy_unconfigured", errorCode: "PROXY_NOT_CONFIGURED" });
    for (const proxy of ["invalid", "http://localhost/path", "socks5://localhost:1080"]) {
      expect(await runHttpsProbe({ HTTPS_PROXY: proxy })).toMatchObject({ status: "proxy_error", errorCode: "INVALID_PROXY_CONFIGURATION" });
    }
  });
  it.each([false, true])("performs a real validated TLS request through an HTTP(S) proxy (encrypted proxy: %s)", async proxyHttps => {
    const fixture = await proxyFixture({ proxyHttps });
    try {
      const result = await runHttpsProbe({ HTTPS_PROXY: fixture.url, NO_PROXY: "*" }, 2000, cert);
      expect(result).toMatchObject({ status: "reachable", httpStatus: 200, proxyStatus: 200 });
      expect(fixture.connections).toEqual([{ target: "www.google.com:443", authorization: undefined }]);
    } finally { await fixture.close(); }
  });
  it("distinguishes an HTTP error response from failing to reach the proxy", async () => {
    const fixture = await proxyFixture({ targetStatus: 503 });
    try {
      expect(await runHttpsProbe({ HTTPS_PROXY: fixture.url }, 2000, cert)).toMatchObject({ status: "http_error", httpStatus: 503, proxyStatus: 200 });
    } finally { await fixture.close(); }
  });
  it("rejects an untrusted TLS certificate", async () => {
    const fixture = await proxyFixture();
    try {
      expect(await runHttpsProbe({ HTTPS_PROXY: fixture.url }, 2000)).toMatchObject({ status: "tls_error", proxyStatus: 200 });
    } finally { await fixture.close(); }
  });
  it("uses HTTPS proxy precedence, supports authentication, and never returns credentials", async () => {
    const fixture = await proxyFixture({ mode: "reject" });
    try {
      const url = new URL(fixture.url); url.username = "probe-user"; url.password = "private-password";
      const result = await new HostNetworkProbe(() => runHttpsProbe({ https_proxy: url.href, HTTPS_PROXY: "http://invalid", ALL_PROXY: "http://invalid" }, 2000)).run();
      expect(result).toMatchObject({ status: "proxy_error", proxyStatus: 407 });
      expect(fixture.connections).toEqual([{ target: "www.google.com:443", authorization: "Basic " + Buffer.from("probe-user:private-password").toString("base64") }]);
      expect(JSON.stringify(result)).not.toContain("private-password"); expect(JSON.stringify(result)).not.toContain("probe-user");
    } finally { await fixture.close(); }
  });
  it.each(["hang", "hang_tls"] as const)("closes pending sockets on a whole-request deadline (%s)", async mode => {
    const fixture = await proxyFixture({ mode });
    try {
      expect(await runHttpsProbe({ HTTPS_PROXY: fixture.url }, 60)).toMatchObject({ status: "timeout", errorCode: "ETIMEDOUT" });
      await vi.waitFor(() => expect(fixture.sockets.size).toBe(0));
    } finally { await fixture.close(); }
  });
  it("shares concurrent manual checks and permits another check after completion", async () => {
    let resolve!: (value: HttpsProbeOutput) => void;
    const runner = vi.fn(() => new Promise<HttpsProbeOutput>(done => { resolve = done; }));
    const probe = new HostNetworkProbe(runner), first = probe.run();
    expect(probe.run()).toBe(first); expect(runner).toHaveBeenCalledTimes(1);
    resolve(success); expect(await first).toMatchObject({ target: "www.google.com", viaProxy: true, protocol: "HTTPS", httpStatus: 200 });
    const second = probe.run(); expect(runner).toHaveBeenCalledTimes(2); resolve(success); await second;
  });
  it("requires login, rejects custom targets, retains a compatible URL, and returns readable failures", async () => {
    let broken = false;
    const runner = vi.fn(async () => { if (broken) throw new Error("private failure"); return success; });
    const app = Fastify(); registerHostResourceRoutes(app, undefined, new HostNetworkProbe(runner));
    const headers = { cookie: createSessionCookie("admin") };
    try {
      for (const url of ["/api/system/network/check", "/api/system/network/ping"]) {
        expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
        expect((await app.inject({ method: "POST", url, headers, payload: { target: "localhost" } })).statusCode).toBe(400);
      }
      expect(runner).not.toHaveBeenCalled();
      const result = await app.inject({ method: "POST", url: "/api/system/network/check", headers });
      expect(result.statusCode).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.json().data).toMatchObject({ status: "reachable", httpStatus: 200 });
      expect((await app.inject({ method: "POST", url: "/api/system/network/ping", headers })).statusCode).toBe(200);
      broken = true;
      const failure = await app.inject({ method: "POST", url: "/api/system/network/check", headers });
      expect(failure.statusCode).toBe(503); expect(failure.body).not.toContain("private failure");
    } finally { await app.close(); }
  });
});
