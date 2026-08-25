#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const target = process.env.CODEX_TAILSCALE_TARGET;
const count = positiveInt("CODEX_TAILSCALE_PINGS", 10);

if (!target) {
  console.error("Set CODEX_TAILSCALE_TARGET to the client Tailscale IP or DNS name.");
  process.exit(2);
}

function positiveInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

const command = spawnSync("tailscale", ["ping", "-c", String(count), "--until-direct=false", target], {
  encoding: "utf8"
});
const output = `${command.stdout || ""}\n${command.stderr || ""}`;
const samples = [];
for (const line of output.split(/\r?\n/)) {
  const match = line.match(/via\s+(DERP\([^)]+\)|\S+)\s+in\s+([0-9.]+)(ms|s)/i);
  if (!match) continue;
  const latencyMs = Number(match[2]) * (match[3].toLowerCase() === "s" ? 1_000 : 1);
  samples.push({ path: match[1], latencyMs });
}

const latencies = samples.map((sample) => sample.latencyMs);
const directSamples = samples.filter((sample) => !sample.path.toUpperCase().startsWith("DERP("));
const derpSamples = samples.length - directSamples.length;
const passed = samples.length > 0 && directSamples.length > 0;
console.log(JSON.stringify({
  passed,
  target,
  requestedPings: count,
  parsedPings: samples.length,
  directSamples: directSamples.length,
  derpSamples,
  paths: [...new Set(samples.map((sample) => sample.path))],
  p50Ms: Math.round(percentile(latencies, 0.5) * 100) / 100,
  p95Ms: Math.round(percentile(latencies, 0.95) * 100) / 100,
  maxMs: Math.round(Math.max(0, ...latencies) * 100) / 100
}, null, 2));

if (!passed) process.exitCode = 1;
