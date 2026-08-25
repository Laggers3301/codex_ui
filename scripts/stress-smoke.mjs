#!/usr/bin/env node

const baseUrl = new URL(process.env.CODEX_STRESS_BASE_URL || "http://127.0.0.1:4575");
const username = process.env.CODEX_STRESS_USER || "gyj";
const password = process.env.CODEX_STRESS_PASSWORD;
const webdriverSession = process.env.CODEX_STRESS_WEBDRIVER_SESSION;
const webdriverUrl = (process.env.CODEX_STRESS_WEBDRIVER_URL || "http://127.0.0.1:4466").replace(/\/$/, "");
const sequentialRequests = positiveInt("CODEX_STRESS_SEQUENTIAL", 20);
const burstRequests = positiveInt("CODEX_STRESS_BURST", 120);
const concurrency = positiveInt("CODEX_STRESS_CONCURRENCY", 24);

if (!password && !webdriverSession) {
  console.error("Set CODEX_STRESS_PASSWORD or CODEX_STRESS_WEBDRIVER_SESSION. Credentials and cookies are never printed.");
  process.exit(2);
}

process.env.NO_PROXY = [
  process.env.NO_PROXY,
  "127.0.0.1",
  "localhost",
  "100.64.0.0/10",
  ".ts.net",
  ".tail6856d9.ts.net"
].filter(Boolean).join(",");

function positiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(label, samples, wallMs) {
  const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const statuses = {};
  let bytes = 0;
  for (const sample of samples) {
    statuses[sample.status] = (statuses[sample.status] || 0) + 1;
    bytes += sample.bytes;
  }
  return {
    label,
    requests: samples.length,
    concurrency: wallMs ? concurrency : 1,
    ok: samples.filter((sample) => sample.status >= 200 && sample.status < 300).length,
    errors: samples.filter((sample) => sample.error).length,
    statuses,
    sampleFailures: samples
      .filter((sample) => sample.status < 200 || sample.status >= 300 || sample.error)
      .slice(0, 3)
      .map((sample) => ({
        status: sample.status,
        error: sample.error,
        body: sample.body.slice(0, 300)
      })),
    bytes,
    wallMs: round(wallMs || times.reduce((sum, value) => sum + value, 0)),
    requestsPerSecond: wallMs ? round(samples.length * 1000 / wallMs) : undefined,
    p50Ms: round(percentile(times, 0.5)),
    p95Ms: round(percentile(times, 0.95)),
    p99Ms: round(percentile(times, 0.99)),
    maxMs: round(times.at(-1) || 0)
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function login() {
  if (webdriverSession) {
    const response = await fetch(`${webdriverUrl}/session/${encodeURIComponent(webdriverSession)}/cookie`);
    if (!response.ok) throw new Error(`WebDriver cookie lookup failed with HTTP ${response.status}`);
    const payload = await response.json();
    const cookies = Array.isArray(payload.value) ? payload.value : [];
    const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    if (!cookie) throw new Error("The authenticated browser session has no cookies");
    return cookie;
  }
  const response = await fetch(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) {
    throw new Error(`Login failed with HTTP ${response.status}`);
  }
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  if (!cookie) throw new Error("Login succeeded but no session cookie was returned");
  return cookie;
}

async function measuredFetch(path, cookie) {
  const startedAt = performance.now();
  try {
    const response = await fetch(new URL(path, baseUrl), {
      headers: {
        cookie,
        "x-codex-web-user-id": username
      },
      cache: "no-store"
    });
    const body = await response.text();
    return {
      status: response.status,
      bytes: Buffer.byteLength(body),
      ms: performance.now() - startedAt,
      body
    };
  } catch (error) {
    return {
      status: 0,
      bytes: 0,
      ms: performance.now() - startedAt,
      body: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function sequential(label, path, cookie) {
  const samples = [];
  await measuredFetch(path, cookie);
  for (let index = 0; index < sequentialRequests; index += 1) {
    samples.push(await measuredFetch(path, cookie));
  }
  return summarize(label, samples);
}

async function burst(label, path, cookie) {
  const warmup = await measuredFetch(path, cookie);
  if (warmup.status < 200 || warmup.status >= 300) {
    throw new Error(`${label} warmup failed with HTTP ${warmup.status}`);
  }
  const samples = new Array(burstRequests);
  let cursor = 0;
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, burstRequests) }, async () => {
    while (cursor < burstRequests) {
      const index = cursor;
      cursor += 1;
      samples[index] = await measuredFetch(path, cookie);
    }
  }));
  return summarize(label, samples, performance.now() - startedAt);
}

function parseData(sample, label) {
  if (sample.status < 200 || sample.status >= 300) {
    throw new Error(`${label} failed with HTTP ${sample.status}`);
  }
  try {
    return JSON.parse(sample.body).data;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function main() {
  const cookie = await login();
  const projectsSample = await measuredFetch("/api/projects", cookie);
  const projects = parseData(projectsSample, "Project discovery");
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: baseUrl.origin,
    username,
    config: { sequentialRequests, burstRequests, concurrency },
    discoveredProjects: projects.map((project) => ({ id: project.id, name: project.name })),
    unavailableEndpoints: [],
    results: []
  };

  report.results.push(await sequential("projects-sequential", "/api/projects", cookie));
  report.results.push(await burst("projects-burst", "/api/projects", cookie));
  const accountPoolProbe = await measuredFetch("/api/codex/account-pool", cookie);
  if (accountPoolProbe.status >= 200 && accountPoolProbe.status < 300) {
    report.results.push(await burst("account-pool-cached-burst", "/api/codex/account-pool", cookie));
  } else {
    report.unavailableEndpoints.push({ path: "/api/codex/account-pool", status: accountPoolProbe.status });
  }

  for (const project of projects) {
    const path = `/api/projects/${encodeURIComponent(project.id)}/threads?fast=true`;
    report.results.push(await sequential(`threads-${project.name}-sequential`, path, cookie));
    report.results.push(await burst(`threads-${project.name}-burst`, path, cookie));
    const threads = parseData(await measuredFetch(path, cookie), `Threads for ${project.name}`);
    const discoveredProject = report.discoveredProjects.find((entry) => entry.id === project.id);
    if (discoveredProject) {
      discoveredProject.threadCount = Array.isArray(threads) ? threads.length : (threads?.threads?.length || 0);
    }
    const thread = Array.isArray(threads) ? threads[0] : threads?.threads?.[0];
    if (thread?.id) {
      const readPath = `/api/threads/${encodeURIComponent(thread.id)}?projectId=${encodeURIComponent(project.id)}&limit=128`;
      report.results.push(await sequential(`thread-${project.name}-sequential`, readPath, cookie));
      report.results.push(await burst(`thread-${project.name}-burst`, readPath, cookie));
    }
  }

  report.passed = report.results.every((result) => result.ok === result.requests && result.errors === 0);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
