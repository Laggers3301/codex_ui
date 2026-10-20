import fs from "node:fs/promises";
import { processes, identity } from "./resource-guardian.mjs";
import {confirmedEdgeCount,probeWebSocket,networkEvidence,NetworkRecoveryPolicy,recoverNetwork,lanIsDegraded} from './network-health.mjs';
import {probeCloudRelay} from './cloud-relay-health.mjs';
const networkRecovery=new NetworkRecoveryPolicy();
let lastNetworkEvidence=null, lastNetworkEvidenceAt=0;

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
  return (await processes()).sort((a, b) => b.rss - a.rss).slice(0, 12).map(identity);
}

async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    const [mem, pressure, backend, mainEdge, quicEdge, workers, frontend, backendWS, frontendWS, mainReady, quicReady, cloudRelay] = await Promise.all([
      readText("/proc/meminfo"),
      readText("/proc/pressure/memory"),
      localGet("http://127.0.0.1:4576/api/health"),
      localGet("http://127.0.0.1:20241/metrics"),
      localGet("http://127.0.0.1:20242/metrics"),
      workerScopes(),
      localGet('http://127.0.0.1:4574/login'),
      probeWebSocket('ws://127.0.0.1:4576/ws'),
      probeWebSocket('ws://127.0.0.1:4574/ws'),
      localGet('http://127.0.0.1:20241/ready'),
      localGet('http://127.0.0.1:20242/ready'),
      probeCloudRelay()
    ]);
    const availableMb = mb(memField(mem, "MemAvailable"));
    const swapFreeMb = mb(memField(mem, "SwapFree"));
    const fullPressure10 = pressureAverage(pressure);
    const mainConnections = cloudRelay?(cloudRelay.ready===200?1:0):confirmedEdgeCount(mainEdge,mainReady);
    const quicConnections = confirmedEdgeCount(quicEdge,quicReady);
    const newWorkerOom = previousWorkerOomKills !== null && workers.oomKills !== null
      && workers.oomKills > previousWorkerOomKills;
    previousWorkerOomKills = workers.oomKills;
    const backendHealthy = backend.status === 200 || backend.status === 401;
    if(Date.now()-lastNetworkEvidenceAt>=60000){lastNetworkEvidence=await networkEvidence();lastNetworkEvidenceAt=Date.now();}
    const snapshot={backendStatus:backend.status,backendWS:backendWS.ok,frontendStatus:frontend.status,frontendWS:frontendWS.ok,mainConnections,quicConnections,cloudRelay,network:lastNetworkEvidence};
    const recovery=networkRecovery.evaluate(snapshot);
    if(recovery)console.warn(JSON.stringify({time:new Date().toISOString(),event:'network-recovery',snapshot,result:await recoverNetwork(recovery)}));
    const disk = await fs.statfs('/');
    const diskAvailableGiB = Math.round(disk.bavail * disk.bsize / 1024 ** 3);
    const inodeAvailable = disk.ffree;
    const critical = availableMb < 768 || fullPressure10 >= 25 || !backendHealthy
      || (mainConnections === 0 && !(quicConnections > 0)) || diskAvailableGiB < 32 || inodeAvailable < 1000;
    const warning = newWorkerOom || availableMb < 2_048 || fullPressure10 >= 10
      || lanIsDegraded(lastNetworkEvidence) || (cloudRelay && cloudRelay.origin!==200)
      || (swapFreeMb < 200 && availableMb < 3_000)
      || !backendWS.ok || !frontendWS.ok || frontend.status!==200 || mainConnections===null
      || (!cloudRelay&&mainConnections!==null&&mainConnections<4) || (quicConnections!==null&&quicConnections<4) || diskAvailableGiB < 64 || inodeAvailable < 10000;
    const level = critical ? "critical" : warning ? "warning" : "healthy";
    const signature = `${level}:${backendHealthy}:${frontend.status}:${backendWS.ok}:${frontendWS.ok}:${mainConnections}:${quicConnections}:${workers.oomKills}`;
    const now = Date.now();
    if (signature !== lastSignature || now - lastReportAt > (level === "healthy" ? 300_000 : 60_000)) {
      const event = {
        time: new Date(now).toISOString(), level, availableMb, swapFreeMb, fullPressure10, diskAvailableGiB, inodeAvailable,
        backendStatus: backend.status, mainConnections, quicConnections, cloudRelay,
        frontendStatus:frontend.status,backendWebSocket:backendWS,frontendWebSocket:frontendWS,network:lastNetworkEvidence,
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
