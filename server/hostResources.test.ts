import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createSessionCookie } from "./auth.js";
import { cpuCounters, diskCounters, memoryCounters, mountForPath, mountInfo, HostResourceMonitor, registerHostResourceRoutes, type RawResources } from "./hostResources.js";

const sample = (at: number): RawResources => ({ at, hostname: "test", platform: "linux", cores: 2, model: "CPU", loadAverage: [1, 2, 3],
  cpu: { total: 1000 + at / 10, idle: 600 + at / 20 }, memory: memoryCounters("MemTotal: 8000 kB\nMemAvailable: 2000 kB\n", 0, 0),
  volumes: [], disks: [{ name: "vda", readBytes: 1024 + at * 2, writeBytes: 2048 + at, busyMs: 100 + at / 4 }], warnings: [] });
describe("host resource sampling", () => {
  it("decodes escaped mount paths and chooses the containing mount instead of a similar prefix", () => {
    const mounts = mountInfo("30 1 259:2 / / rw shared:1 - ext4 /dev/nvme0n1p2 rw\n31 30 8:1 / /data\\040disk rw - ext4 /dev/sda1 rw\n32 30 8:2 / /data rw - ext4 /dev/sda2 rw\n33 32 8:3 / /data/nested\\134folder rw - ext4 /dev/sdb1 rw\nmalformed");
    expect(mountForPath(mounts, "/data disk/project")).toBe("/data disk");
    expect(mountForPath(mounts, "/database/project")).toBe("/");
    expect(mountForPath(mounts, "/data/nested\\folder/project")).toBe("/data/nested\\folder");
    expect(mountForPath([], "/data")).toBeNull();
  });
  it("excludes already-counted guest time and treats I/O wait separately from CPU busy time", () => {
    expect(cpuCounters("cpu 10 20 30 40 50 60 70 80 90 100\ncpu0 1 1 1 1")).toEqual({ total: 360, idle: 90 });
    expect(cpuCounters("cpu not-a-counter")).toBeNull();
  });
  it("uses available memory rather than counting reclaimable cache as used memory", () => {
    const memory = memoryCounters("MemTotal: 8000 kB\nMemFree: 100 kB\nMemAvailable: 2000 kB\nSwapTotal: 1000 kB\nSwapFree: 250 kB\n", 1, 1);
    expect(memory.usagePercent).toBe(75); expect(memory.usedBytes).toBe(6000 * 1024); expect(memory.swapUsedBytes).toBe(750 * 1024);
    expect(memoryCounters("", 1000, 400).swapTotalBytes).toBeNull();
  });
  it("counts only selected whole devices and uses the kernel's 512-byte sector counters", () => {
    const text = "8 0 sda 1 0 8 0 1 0 4 0 0 100 100\n8 1 sda1 1 0 8 0 1 0 4 0 0 100 100\n7 0 loop0 1 0 8 0 1 0 4 0 0 100 100";
    expect(diskCounters(text, new Set(["sda"]))).toEqual([{ name: "sda", readBytes: 4096, writeBytes: 2048, busyMs: 100 }]);
  });
  it("calculates actual interval deltas and never invents a first-sample load", async () => {
    let now = 0;
    const monitor = new HostResourceMonitor({ now: () => now, capture: async () => sample(now) });
    expect((await monitor.read()).cpu.usagePercent).toBeNull();
    now = 2000; const data = await monitor.read();
    expect(data.intervalMs).toBe(2000); expect(data.cpu.usagePercent).toBe(50);
    expect(data.disks[0]).toMatchObject({ readBytesPerSecond: 2000, writeBytesPerSecond: 1000, busyPercent: 25 });
    now = 40_000; expect((await monitor.read()).cpu.usagePercent).toBeNull();
  });
  it("shares a one-second cache and coalesces simultaneous requests", async () => {
    let now = 0, captures = 0, release!: (sample: RawResources) => void;
    const monitor = new HostResourceMonitor({ now: () => now, capture: () => { captures++; return new Promise(resolve => { release = resolve; }); } });
    const a = monitor.read(), b = monitor.read(); expect(a).toBe(b); expect(captures).toBe(1); release(sample(0)); await a;
    now = 999; await monitor.read(); expect(captures).toBe(1);
    now = 1000; const c = monitor.read(); expect(captures).toBe(2); release(sample(now)); await c;
  });
  it("does not show negative rates when a device counter resets", async () => {
    let now = 0;
    const monitor = new HostResourceMonitor({ now: () => now, capture: async () => {
      const value = sample(now); if (now) { value.disks[0].readBytes = 0; value.cpu = { total: 1, idle: 0 }; } return value;
    } });
    await monitor.read(); now = 2000; const data = await monitor.read();
    expect(data.cpu.usagePercent).toBeNull(); expect(data.disks[0].readBytesPerSecond).toBeNull();
  });
  it("requires authentication, disables HTTP caching, and returns readable sampling errors", async () => {
    let fail = false;
    const app = Fastify(), monitor = new HostResourceMonitor({ ttlMs: 0, capture: async () => { if (fail) throw new Error("private host details"); return sample(0); } });
    registerHostResourceRoutes(app, monitor);
    try {
      expect((await app.inject({ url: "/api/system/resources" })).statusCode).toBe(401);
      const headers = { cookie: createSessionCookie("admin") };
      const ok = await app.inject({ url: "/api/system/resources", headers }); expect(ok.statusCode).toBe(200); expect(ok.headers["cache-control"]).toBe("no-store");
      fail = true; const error = await app.inject({ url: "/api/system/resources", headers }); expect(error.statusCode).toBe(503); expect(error.body).not.toContain("private host details");
    } finally { await app.close(); }
  });
});
