import { request as httpRequest, type ClientRequest } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { HostNetworkProbeResult } from "../shared/hostResources.js";

export const hostNetworkTarget = new URL("https://www.google.com/");
type ProbeStatus = HostNetworkProbeResult["status"];
export type HttpsProbeOutput = { status: ProbeStatus; message: string; httpStatus: number | null; proxyStatus: number | null; errorCode?: string };
const failed = (status: ProbeStatus, message: string, errorCode: string): HttpsProbeOutput => ({ status, message, httpStatus: null, proxyStatus: null, errorCode });

export function runHttpsProbe(env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000, ca?: ConnectionOptions["ca"]): Promise<HttpsProbeOutput> {
  const configured = env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (!configured?.trim()) return Promise.resolve(failed("proxy_unconfigured", "服务尚未配置代理，无法执行代理 HTTPS 检测。", "PROXY_NOT_CONFIGURED"));
  let proxy: URL, authorization: string | undefined;
  try {
    proxy = new URL(configured.trim());
    if (!["http:", "https:"].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== "/" || proxy.search || proxy.hash) throw new Error();
    if (proxy.username || proxy.password) authorization = "Basic " + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
  } catch {
    return Promise.resolve(failed("proxy_error", "代理配置无效；当前检测支持 HTTP/HTTPS 代理地址。", "INVALID_PROXY_CONFIGURATION"));
  }
  return new Promise(resolve => {
    let settled = false, stage: "proxy" | "https" = "proxy", proxyStatus: number | null = null;
    let tunnel: Socket | undefined, secure: TLSSocket | undefined, targetRequest: ClientRequest | undefined, connectRequest: ClientRequest | undefined;
    let agent: Agent | undefined;
    const finish = (result: HttpsProbeOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      targetRequest?.destroy(); connectRequest?.destroy();
      secure?.destroy(); tunnel?.destroy(); agent?.destroy();
      resolve({ ...result, proxyStatus });
    };
    const failure = (error: NodeJS.ErrnoException) => {
      const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "REQUEST_FAILED";
      const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code);
      const status: ProbeStatus = tls ? "tls_error" : ["ENOTFOUND", "EAI_AGAIN"].includes(code) ? "dns_error" : "proxy_error";
      const message = tls ? "HTTPS 证书或 TLS 握手验证失败。" : status === "dns_error" ? "无法解析代理服务器地址。" : stage === "proxy" ? "无法通过配置的代理建立 HTTPS 通道。" : "代理通道已建立，但 HTTPS 请求未能完成。";
      finish(failed(status, message, code));
    };
    const timer = setTimeout(() => finish(failed("timeout", "代理 HTTPS 检测超时，请稍后重试。", "ETIMEDOUT")), timeoutMs);
    try {
      const headers: Record<string, string> = { Host: `${hostNetworkTarget.hostname}:443` };
      if (authorization) headers["Proxy-Authorization"] = authorization;
      // Connect explicitly to the configured proxy, without a global Agent
      // that might automatically proxy the proxy request a second time.
      connectRequest = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
        hostname: proxy.hostname.replace(/^\[|\]$/g, ""), port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT", path: `${hostNetworkTarget.hostname}:443`, headers, agent: false, maxHeaderSize: 16_384, ...(ca ? { ca } : {}),
      });
      connectRequest.on("error", failure);
      connectRequest.on("response", response => {
        proxyStatus = response.statusCode ?? null; response.resume();
        finish(failed("proxy_error", "代理没有建立 HTTPS 通道，请检查代理设置。", "PROXY_CONNECT_FAILED"));
      });
      connectRequest.on("connect", (response, socket, head) => {
        tunnel = socket;
        if (settled) { socket.destroy(); return; }
        proxyStatus = response.statusCode ?? null;
        if (proxyStatus !== 200) {
          finish(failed("proxy_error", proxyStatus === 407 ? "代理要求身份认证，请检查服务的代理凭据。" : `代理拒绝建立 HTTPS 通道（HTTP ${proxyStatus ?? "未知"}）。`, "PROXY_CONNECT_REJECTED"));
          return;
        }
        if (head.length) socket.unshift(head);
        stage = "https";
        try {
          secure = tlsConnect({ socket, servername: hostNetworkTarget.hostname, rejectUnauthorized: true, ...(ca ? { ca } : {}) });
          secure.on("error", failure);
          agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
          agent.createConnection = () => secure!;
          targetRequest = httpsRequest(hostNetworkTarget, { agent, method: "HEAD", maxHeaderSize: 16_384 }, result => {
            const httpStatus = result.statusCode ?? null;
            result.on("error", failure);
            result.on("end", () => finish({
              status: httpStatus != null && httpStatus >= 200 && httpStatus < 400 ? "reachable" : "http_error",
              message: httpStatus != null && httpStatus >= 200 && httpStatus < 400 ? `通过服务代理的 HTTPS 连接成功（HTTP ${httpStatus}）。` : `代理及 HTTPS 连接成功，但目标返回 HTTP ${httpStatus ?? "未知"}。`,
              httpStatus, proxyStatus,
            }));
            result.resume();
          });
          targetRequest.on("error", failure); targetRequest.end();
        } catch (error) { failure(error as NodeJS.ErrnoException); }
      });
      connectRequest.end();
    } catch (error) { failure(error as NodeJS.ErrnoException); }
  });
}

/** Manual probes share one bounded request; resource polling never invokes it. */
export class HostNetworkProbe {
  private inFlight: Promise<HostNetworkProbeResult> | null = null;
  constructor(private runner: () => Promise<HttpsProbeOutput> = runHttpsProbe) {}
  run(): Promise<HostNetworkProbeResult> {
    if (this.inFlight) return this.inFlight;
    const startedAt = new Date().toISOString(), start = performance.now();
    this.inFlight = this.runner().then(raw => ({
      target: "www.google.com" as const, protocol: "HTTPS" as const, viaProxy: true as const,
      startedAt, durationMs: Math.round(performance.now() - start), status: raw.status, message: raw.message,
      httpStatus: raw.httpStatus, proxyStatus: raw.proxyStatus,
      output: [`HEAD ${hostNetworkTarget.href}`, "连接方式：服务配置的代理", raw.proxyStatus != null ? `代理 CONNECT：HTTP ${raw.proxyStatus}` : "", raw.httpStatus != null ? `目标响应：HTTP ${raw.httpStatus}` : "", raw.errorCode ? `诊断代码：${raw.errorCode}` : ""].filter(Boolean).join("\n"),
    })).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}
