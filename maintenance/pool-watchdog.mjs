import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const intervalMs = 15_000;
const mb = (bytes) => Math.round(bytes / 1024 / 1024);
let lastSignature = "";
let lastReportAt = 0;
let sampling = false;
let previousWorkerOomKills = null;

async function readText(file) {
  try { return await fs.readFile(file, "utf8"); } catch { return ""; }
}

function memField(text, name) {
  const match = text.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m"));
  return match ? Number(match[1]) * 1024 : 0;
}

function pressureAverage(text) {
  const match = text.match(/^full\s+avg10=([\d.]+)/m);
  return match ? Number(match[1]) : 0;
}

async function localGet(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { status: 0, text: "", error: error instanceof Error ? error.name : "error" };
  }
}

function edgeConnections(response) {
  const match = response.text.match(/^cloudflared_tunnel_ha_connections\s+(\d+)/m);
  return match ? Number(match[1]) : 0;
}

async function workerScopes() {
  const ownCgroup = await readText("/proc/self/cgroup");
  const root = ownCgroup.match(/0::(.*?\/user@\d+\.service)(?:\/|$)/)?.[1];
  if (!root) return { memoryMb: null, oomKills: null, highEvents: null, scopes: [] };
  // A named user slice is nested under codex.slice, not directly under user@.service.
  const directory = `/sys/fs/cgroup${root}/codex.slice/codex-workers.slice`;
  const totalText = (await readText(`${directory}/memory.current`)).trim();
  const total = totalText ? Number(totalText) : null;
  const sliceEvents = await readText(`${directory}/memory.events`);
  const oomKills = sliceEvents.match(/^oom_kill\s+(\d+)/m);
  const highEvents = sliceEvents.match(/^high\s+(\d+)/m);
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { /* slice not started yet */ }
  const scopes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^codex-agent-.*\.scope$/.test(entry.name)) continue;
    const currentText = (await readText(`${directory}/${entry.name}/memory.current`)).trim();
    const current = currentText ? Number(currentText) : null;
    const events = await readText(`${directory}/${entry.name}/memory.events`);
    scopes.push({
      account: entry.name.replace(/^codex-agent-/, "").replace(/-[^-]+\.scope$/, ""),
      memoryMb: current !== null && Number.isFinite(current) ? mb(current) : null,
      oomKills: Number(events.match(/^oom_kill\s+(\d+)/m)?.[1] ?? 0)
    });
  }
  scopes.sort((left, right) => (right.memoryMb ?? 0) - (left.memoryMb ?? 0));
  return {
    memoryMb: total !== null && Number.isFinite(total) ? mb(total) : null,
    oomKills: oomKills ? Number(oomKills[1]) : null,
    highEvents: highEvents ? Number(highEvents[1]) : null,
    scopes
  };
}

async function topProcesses() {
  let output = "";
  try {
    ({ stdout: output } = await execFileAsync("/usr/bin/ps", ["-eo", "pid=,rss=,comm=", "--sort=-rss"], {
      timeout: 2_000, maxBuffer: 1024 * 1024
    }));
  } catch { return []; }
  const result = [];
  for (const line of output.trim().split("\n").slice(0, 12)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    let cwd = "";
    try { cwd = await fs.readlink(`/proc/${pid}/cwd`); } catch { /* process exited */ }
    const owner = cwd.match(/\/users\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] ?? null;
    const category = cwd.includes("ms-python.vscode-pylance") ? "VS Code Pylance" : match[3];
    result.push({ pid, name: category, rssMb: Math.round(Number(match[2]) / 1024), owner });
  }
  return result;
}

async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    const [mem, pressure, backend, mainEdge, quicEdge, workers] = await Promise.all([
      readText("/proc/meminfo"),
      readText("/proc/pressure/memory"),
      localGet("http://127.0.0.1:4576/api/health"),
      localGet("http://127.0.0.1:20241/metrics"),
      localGet("http://127.0.0.1:20242/metrics"),
      workerScopes()
    ]);
    const availableMb = mb(memField(mem, "MemAvailable"));
    const swapFreeMb = mb(memField(mem, "SwapFree"));
    const fullPressure10 = pressureAverage(pressure);
    const mainConnections = edgeConnections(mainEdge);
    const quicConnections = edgeConnections(quicEdge);
    const newWorkerOom = previousWorkerOomKills !== null && workers.oomKills !== null
      && workers.oomKills > previousWorkerOomKills;
    previousWorkerOomKills = workers.oomKills;
    const backendHealthy = backend.status === 200 || backend.status === 401;
    const critical = availableMb < 768 || fullPressure10 >= 25 || !backendHealthy
      || (mainConnections === 0 && quicConnections === 0);
    const warning = newWorkerOom || availableMb < 2_048 || fullPressure10 >= 10
      || (swapFreeMb < 200 && availableMb < 3_000)
      || mainConnections < 4 || quicConnections < 4;
    const level = critical ? "critical" : warning ? "warning" : "healthy";
    const signature = `${level}:${backendHealthy}:${mainConnections}:${quicConnections}:${workers.oomKills}`;
    const now = Date.now();
    if (signature !== lastSignature || now - lastReportAt > (level === "healthy" ? 300_000 : 60_000)) {
      const event = {
        time: new Date(now).toISOString(), level, availableMb, swapFreeMb, fullPressure10,
        backendStatus: backend.status, mainConnections, quicConnections,
        workerSliceMb: workers.memoryMb, workerOomKills: workers.oomKills,
        workerHighEvents: workers.highEvents, workerScopes: workers.scopes
      };
      if (level !== "healthy") event.topProcesses = await topProcesses();
      (level === "critical" ? console.error : console.log)(JSON.stringify(event));
      lastSignature = signature;
      lastReportAt = now;
    }
  } catch (error) {
    console.error(JSON.stringify({ time: new Date().toISOString(), level: "watchdog-error",
      error: error instanceof Error ? error.message : String(error) }));
  } finally {
    sampling = false;
  }
}

await sample();
if (process.argv.includes("--once")) process.exit(0);
setInterval(() => { void sample(); }, intervalMs);
