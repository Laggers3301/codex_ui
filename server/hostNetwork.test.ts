import { execFile } from "node:child_process";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "./auth.js";
import { HostNetworkProbe, pingResult } from "./hostNetwork.js";
import { registerHostResourceRoutes } from "./hostResources.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const reply = "PING google.com (142.250.1.1) 56(84) bytes of data.\n3 packets transmitted, 3 received, 0% packet loss, time 2002ms\nrtt min/avg/max/mdev = 19.0/20.5/23.0/1.5 ms";
describe("manual host network checks", () => {
  it("reports latency, loss and the resolved address, including partial reachability", () => {
    expect(pingResult({ stdout: reply, stderr: "", code: 0 }, "2026-10-28T00:00:00Z", 2000)).toMatchObject({
      status: "reachable", target: "google.com", address: "142.250.1.1", averageLatencyMs: 20.5, packetLossPercent: 0, packetsReceived: 3
    });
    expect(pingResult({ stdout: reply.replace("3 received, 0%", "1 received, 66.7%"), stderr: "", code: 1 }, "now", 2000)).toMatchObject({ status: "reachable", packetLossPercent: 66.7 });
  });
  it("distinguishes DNS, permissions, unavailable commands, routing errors and timeouts without claiming the whole Internet is down", () => {
    for (const [raw, status] of [
      [{ stdout: "", stderr: "ping: google.com: Temporary failure in name resolution", code: 2 }, "dns_error"],
      [{ stdout: "", stderr: "ping: socket: Operation not permitted", code: 2 }, "permission_denied"],
      [{ stdout: "", stderr: "", code: "ENOENT" }, "unavailable"],
      [{ stdout: "Destination Host Unreachable", stderr: "", code: 1 }, "unreachable"],
      [{ stdout: "3 packets transmitted, 0 received, 100% packet loss", stderr: "", code: 1 }, "timeout"],
      [{ stdout: "PING google.com (142.250.1.1)", stderr: "", timedOut: true }, "timeout"]
    ] as const) expect(pingResult(raw, "now", 9000).status).toBe(status);
  });
  it("uses a fixed destination and finite probe count, with a process deadline and graceful termination", async () => {
    vi.mocked(execFile).mockImplementationOnce((file: any, args: any, options: any, done: any) => {
      expect(file).toBe("ping"); expect(args).toContain("google.com");
      expect(Number(args[args.indexOf("-c") + 1])).toBeLessThanOrEqual(3);
      expect(Number(args[args.indexOf("-w") + 1])).toBeLessThanOrEqual(7);
      expect(options).toMatchObject({ timeout: 9000, killSignal: "SIGTERM", env: { LC_ALL: "C" } });
      expect(options.shell).not.toBe(true);
      done(null, reply, ""); return {} as any;
    });
    expect((await new HostNetworkProbe().run()).status).toBe("reachable");
  });
  it("shares concurrent checks, and lets a later manual click run a new probe", async () => {
    let resolve!: (value: { stdout: string; stderr: string }) => void;
    const run = vi.fn(() => new Promise<{ stdout: string; stderr: string }>(done => { resolve = done; }));
    const probe = new HostNetworkProbe(run), first = probe.run(), concurrent = probe.run();
    expect(concurrent).toBe(first); expect(run).toHaveBeenCalledTimes(1);
    resolve({ stdout: reply, stderr: "" }); await first;
    const next = probe.run(); expect(run).toHaveBeenCalledTimes(2); resolve({ stdout: reply, stderr: "" }); await next;
  });
  it("requires login, rejects custom targets, and preserves actionable output without leaking unexpected errors", async () => {
    let broken = false;
    const run = vi.fn(async () => { if (broken) throw new Error("private failure"); return { stdout: "", stderr: "ping: google.com: Temporary failure in name resolution", code: 2 }; });
    const app = Fastify(); registerHostResourceRoutes(app, undefined, new HostNetworkProbe(run));
    const headers = { cookie: createSessionCookie("admin") }, url = "/api/system/network/ping";
    try {
      expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
      expect(run).not.toHaveBeenCalled();
      expect((await app.inject({ method: "POST", url, headers, payload: { target: "localhost; echo injection" } })).statusCode).toBe(400);
      expect(run).not.toHaveBeenCalled();
      const response = await app.inject({ method: "POST", url, headers });
      expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json().data).toMatchObject({ status: "dns_error", output: "ping: google.com: Temporary failure in name resolution" });
      broken = true; const failure = await app.inject({ method: "POST", url, headers });
      expect(failure.statusCode).toBe(503); expect(failure.body).not.toContain("private failure");
    } finally { await app.close(); }
  });
});
