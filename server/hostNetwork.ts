import { execFile } from "node:child_process";
import type { HostNetworkProbeResult } from "../shared/hostResources.js";

type PingOutput = { stdout: string; stderr: string; code?: string | number | null; timedOut?: boolean };
export const hostPingArgs = ["-n", "-c", "3", "-W", "2", "-w", "7", "google.com"] as const;
function runPing(): Promise<PingOutput> {
  if (process.platform !== "linux") return Promise.resolve({ stdout: "", stderr: "", code: "UNSUPPORTED" });
  return new Promise(resolve => {
    execFile("ping", [...hostPingArgs], { timeout: 9000, killSignal: "SIGTERM", maxBuffer: 16_384,
      env: { ...process.env, LC_ALL: "C", LANG: "C" } }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error?.code ?? 0, timedOut: error?.killed === true });
    });
  });
}
export function pingResult(raw: PingOutput, startedAt: string, durationMs: number): HostNetworkProbeResult {
  const output = [raw.stdout, raw.stderr].filter(Boolean).join("\n").trim().slice(0, 8000);
  const packets = output.match(/(\d+) packets transmitted,\s*(\d+) (?:packets )?received/);
  const loss = output.match(/([\d.]+)% packet loss/);
  const latency = output.match(/(?:rtt|round-trip) min\/avg\/max\/(?:mdev|stddev) = [\d.]+\/([\d.]+)\//);
  const received = packets ? Number(packets[2]) : null;
  let status: HostNetworkProbeResult["status"], message: string;
  if (received != null && received > 0) { status = "reachable"; message = "已收到 google.com 的 ICMP 应答。"; }
  else if (raw.code === "ENOENT" || raw.code === "UNSUPPORTED") { status = "unavailable"; message = "当前主机未提供可用的 ping 命令。"; }
  else if (["EACCES", "EPERM"].includes(String(raw.code)) || /permission denied|operation not permitted/i.test(output)) { status = "permission_denied"; message = "当前主机没有发送 ICMP 探测的权限。"; }
  else if (/name or service not known|temporary failure in name resolution|unknown host|bad address/i.test(output)) { status = "dns_error"; message = "无法解析 google.com，请检查主机 DNS。"; }
  else if (/unreachable|network is down/i.test(output)) { status = "unreachable"; message = "主机或网络返回不可达错误。"; }
  else if (raw.timedOut || received === 0 || raw.code === 1) { status = "timeout"; message = "本次检测未收到 ICMP 应答。"; }
  else { status = "error"; message = "ping 检测未正常完成，请查看诊断输出。"; }
  return { target: "google.com", startedAt, durationMs, status, message,
    address: output.match(/^PING\s+[^\s(]+\s+\(([^)]+)\)/m)?.[1] ?? null,
    packetsTransmitted: packets ? Number(packets[1]) : null, packetsReceived: received,
    packetLossPercent: loss ? Number(loss[1]) : null, averageLatencyMs: latency ? Number(latency[1]) : null, output };
}

/** Manual probes share one bounded process; resource polling never invokes it. */
export class HostNetworkProbe {
  private inFlight: Promise<HostNetworkProbeResult> | null = null;
  constructor(private runner: () => Promise<PingOutput> = runPing) {}
  run(): Promise<HostNetworkProbeResult> {
    if (this.inFlight) return this.inFlight;
    const startedAt = new Date().toISOString(), start = performance.now();
    this.inFlight = this.runner().then(raw => pingResult(raw, startedAt, Math.round(performance.now() - start)))
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}
