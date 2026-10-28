import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { authenticatedUserFromHeaders } from "./auth.js";
import { serverConfig } from "./config.js";
import type { HostResources } from "../shared/hostResources.js";
import { HostNetworkProbe } from "./hostNetwork.js";

const percent = (part: number, total: number) => total > 0 ? Math.max(0, Math.min(100, part / total * 100)) : 0;
export function cpuCounters(text: string): { total: number; idle: number } | null {
  const match = text.match(/^cpu\s+(.+)$/m);
  if (!match) return null;
  // guest and guest_nice are already included in user and nice.
  const ticks = match[1].trim().split(/\s+/).slice(0, 8).map(Number);
  if (ticks.length < 4 || ticks.some(value => !Number.isFinite(value) || value < 0)) return null;
  return { total: ticks.reduce((sum, value) => sum + value, 0), idle: ticks[3] + (ticks[4] ?? 0) };
}
export function memoryCounters(text: string, totalFallback: number, availableFallback: number): HostResources["memory"] {
  const entries = Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map(match => [match[1], Number(match[2]) * 1024]));
  const totalBytes = entries.MemTotal ?? totalFallback;
  const availableBytes = Math.max(0, Math.min(totalBytes, entries.MemAvailable ?? availableFallback));
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return { totalBytes, availableBytes, usedBytes, usagePercent: percent(usedBytes, totalBytes),
    swapTotalBytes: entries.SwapTotal ?? null,
    swapUsedBytes: entries.SwapTotal === undefined || entries.SwapFree === undefined ? null : Math.max(0, entries.SwapTotal - entries.SwapFree) };
}
export type DiskCounter = { name: string; readBytes: number; writeBytes: number; busyMs: number; mountPoints?: string[] };
export function diskCounters(text: string, devices: Set<string>): DiskCounter[] {
  return text.trim().split("\n").flatMap(line => {
    const fields = line.trim().split(/\s+/);
    if (!devices.has(fields[2]) || fields.length < 14) return [];
    const values = [Number(fields[5]) * 512, Number(fields[9]) * 512, Number(fields[12])];
    if (values.some(value => !Number.isFinite(value) || value < 0)) return [];
    return [{ name: fields[2], readBytes: values[0], writeBytes: values[1], busyMs: values[2] }];
  });
}
export type RawResources = {
  at: number; hostname: string; platform: string; cores: number; model: string; loadAverage: number[] | null;
  cpu: { total: number; idle: number } | null; memory: HostResources["memory"];
  volumes: HostResources["volumes"]; disks: DiskCounter[]; warnings: string[];
};
type VolumeRoot = { label: string; path: string };
const textOf = (file: string) => fs.readFile(file, "utf8").catch(() => "");
type Mount = { device: string; mountPoint: string };
export function mountInfo(text: string): Mount[] {
  return text.split("\n").flatMap(line => {
    const separator = line.indexOf(" - "), fields = line.slice(0, separator).split(" ");
    if (separator < 0 || fields.length < 6 || !/^\d+:\d+$/.test(fields[2]) || !fields[4].startsWith("/")) return [];
    return [{ device: fields[2], mountPoint: fields[4].replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8))) }];
  });
}
export function mountForPath(mounts: Mount[], directory: string): string | null {
  let selected: string | null = null;
  for (const { mountPoint } of mounts) if ((directory === mountPoint || directory.startsWith(mountPoint === "/" ? "/" : mountPoint + "/")) && mountPoint.length >= (selected?.length ?? 0)) selected = mountPoint;
  return selected;
}
async function capture(roots: VolumeRoot[]): Promise<RawResources> {
  const [cpuText, memoryText, diskText, mountText, devices, volumes] = await Promise.all([
    textOf("/proc/stat"), textOf("/proc/meminfo"), textOf("/proc/diskstats"),
    textOf("/proc/self/mountinfo"),
    fs.readdir("/sys/block").then(async names => (await Promise.all(names.map(async name => {
      const target = await fs.realpath(`/sys/block/${name}`).catch(() => "");
      return target && !target.includes("/virtual/block/") ? { name, path: target } : null;
    }))).filter((value): value is { name: string; path: string } => value !== null)).catch(() => []),
    Promise.allSettled(roots.map(async root => {
      const [stat, space, directory] = await Promise.all([fs.stat(root.path), fs.statfs(root.path), fs.realpath(root.path)]);
      const totalBytes = space.blocks * space.bsize, freeBytes = space.bfree * space.bsize;
      if (!(totalBytes > 0)) throw new Error("Volume space is unavailable");
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      return { device: stat.dev, labels: [root.label], paths: [{ label: root.label, path: directory }], totalBytes, usedBytes, availableBytes: Math.max(0, space.bavail * space.bsize), usagePercent: percent(usedBytes, totalBytes) };
    }))
  ]);
  const cpus = os.cpus();
  const nativeCpu = cpuCounters(cpuText);
  const fallbackCpu = cpus.length ? cpus.reduce((sum, cpu) => ({
    total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0), idle: sum.idle + cpu.times.idle
  }), { total: 0, idle: 0 }) : null;
  const uniqueVolumes = new Map<number, HostResources["volumes"][number]>();
  const mounts = mountInfo(mountText);
  for (const volume of volumes) if (volume.status === "fulfilled") {
    const existing = uniqueVolumes.get(volume.value.device);
    const mount = mountForPath(mounts, volume.value.paths[0].path);
    if (existing) { existing.labels.push(...volume.value.labels); existing.paths.push(...volume.value.paths); if (mount && !existing.mountPoints.includes(mount)) existing.mountPoints.push(mount); }
    else { const { device, ...value } = volume.value; uniqueVolumes.set(device, { ...value, mountPoints: mount ? [mount] : [] }); }
  }
  const deviceMounts = await Promise.all([...new Set(mounts.map(mount => mount.device).filter(device => !device.startsWith("0:")))].map(async device => ({
    device, path: await fs.realpath(`/sys/dev/block/${device}`).catch(() => "")
  })));
  const disks = diskCounters(diskText, new Set(devices.map(device => device.name))).map(disk => {
    const device = devices.find(device => device.name === disk.name)!;
    const ids = new Set(deviceMounts.filter(mount => mount.path === device.path || mount.path.startsWith(device.path + path.sep)).map(mount => mount.device));
    return { ...disk, mountPoints: [...new Set(mounts.filter(mount => ids.has(mount.device)).map(mount => mount.mountPoint))] };
  });
  return { at: performance.now(), hostname: os.hostname(), platform: os.platform(), cores: cpus.length,
    model: cpus[0]?.model ?? "", loadAverage: os.platform() === "win32" ? null : os.loadavg(),
    cpu: nativeCpu ?? fallbackCpu, memory: memoryCounters(memoryText, os.totalmem(), os.freemem()),
    volumes: [...uniqueVolumes.values()], disks,
    warnings: [!disks.length ? "当前环境未提供物理磁盘 I/O 数据。" : "", volumes.some(value => value.status === "rejected") ? "部分目录的磁盘空间暂时无法读取。" : ""].filter(Boolean) };
}

export class HostResourceMonitor {
  private previous: RawResources | null = null;
  private cached: { at: number; data: HostResources } | null = null;
  private inFlight: Promise<HostResources> | null = null;
  constructor(private options: { roots?: VolumeRoot[]; capture?: () => Promise<RawResources>; now?: () => number; ttlMs?: number } = {}) {}
  read(): Promise<HostResources> {
    const now = this.options.now?.() ?? performance.now();
    if (this.cached && now - this.cached.at < (this.options.ttlMs ?? 1000)) return Promise.resolve(this.cached.data);
    if (this.inFlight) return this.inFlight;
    this.inFlight = (this.options.capture?.() ?? capture(this.options.roots ?? [
      { label: "系统", path: os.platform() === "win32" ? process.cwd() : "/" },
      { label: "数据目录", path: serverConfig.dataDir }, { label: "工作目录", path: serverConfig.projectRoot }
    ])).then(raw => {
      const previous = this.previous;
      const elapsed = previous ? raw.at - previous.at : 0;
      const sampled = elapsed >= 500 && elapsed <= 30_000;
      const total = raw.cpu && previous?.cpu ? raw.cpu.total - previous.cpu.total : 0;
      const idle = raw.cpu && previous?.cpu ? raw.cpu.idle - previous.cpu.idle : -1;
      const data: HostResources = {
        sampledAt: new Date().toISOString(), intervalMs: sampled ? elapsed : null, hostname: raw.hostname, platform: raw.platform,
        cpu: { cores: raw.cores, model: raw.model, loadAverage: raw.loadAverage,
          usagePercent: sampled && total > 0 && idle >= 0 && idle <= total ? percent(total - idle, total) : null },
        memory: raw.memory, volumes: raw.volumes, warnings: raw.warnings,
        disks: raw.disks.map(disk => {
          const last = previous?.disks.find(value => value.name === disk.name);
          const valid = sampled && last && disk.readBytes >= last.readBytes && disk.writeBytes >= last.writeBytes && disk.busyMs >= last.busyMs;
          return { name: disk.name, mountPoints: disk.mountPoints ?? [], readBytesPerSecond: valid ? (disk.readBytes - last.readBytes) * 1000 / elapsed : null,
            writeBytesPerSecond: valid ? (disk.writeBytes - last.writeBytes) * 1000 / elapsed : null,
            busyPercent: valid ? percent(disk.busyMs - last.busyMs, elapsed) : null };
        })
      };
      this.previous = raw; this.cached = { at: this.options.now?.() ?? performance.now(), data }; return data;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}

export function registerHostResourceRoutes(app: FastifyInstance, monitor = new HostResourceMonitor(), network = new HostNetworkProbe()): void {
  app.get("/api/system/resources", async (request, reply) => {
    if (!authenticatedUserFromHeaders(request.headers)) return reply.code(401).send({ error: "请先登录。" });
    reply.header("Cache-Control", "no-store");
    try { return { data: await monitor.read() }; }
    catch { return reply.code(503).send({ error: "暂时无法读取主机资源状态，请稍后重试。" }); }
  });
  // Keep the old URL for tabs opened before the HTTPS checker was released.
  for (const url of ["/api/system/network/check", "/api/system/network/ping"]) app.post(url, async (request, reply) => {
    if (!authenticatedUserFromHeaders(request.headers)) return reply.code(401).send({ error: "请先登录。" });
    reply.header("Cache-Control", "no-store");
    if (request.body !== undefined && (!request.body || typeof request.body !== "object" || Array.isArray(request.body) || Object.keys(request.body).length)) return reply.code(400).send({ error: "此按钮仅支持通过服务代理检测 www.google.com。" });
    try { return { data: await network.run() }; }
    catch { return reply.code(503).send({ error: "暂时无法执行主机网络检测，请稍后重试。" }); }
  });
}
