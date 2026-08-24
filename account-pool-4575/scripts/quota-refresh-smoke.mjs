#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const baseUrl = new URL(process.env.CODEX_QUOTA_BASE_URL || "http://127.0.0.1:4575");
const webdriverUrl = (process.env.CODEX_WEBDRIVER_URL || "http://127.0.0.1:4466").replace(/\/$/, "");
const webdriverSession = process.env.CODEX_WEBDRIVER_SESSION;
const quotaRequests = positiveInt("CODEX_QUOTA_REQUESTS", 80);
const listRequests = positiveInt("CODEX_QUOTA_LIST_REQUESTS", 120);

const tailnetHost = baseUrl.hostname.endsWith(".ts.net") || baseUrl.hostname.endsWith(".tail6856d9.ts.net");
const proxyConfigured = Boolean(process.env.NODE_USE_ENV_PROXY
  || process.env.HTTP_PROXY
  || process.env.HTTPS_PROXY
  || process.env.ALL_PROXY
  || process.env.http_proxy
  || process.env.https_proxy
  || process.env.all_proxy);
if (tailnetHost && proxyConfigured && process.env.CODEX_QUOTA_PROXY_CLEAN !== "1") {
  const environment = { ...process.env, CODEX_QUOTA_PROXY_CLEAN: "1" };
  for (const name of ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete environment[name];
  }
  const child = spawnSync(process.execPath, process.argv.slice(1), { env: environment, stdio: "inherit" });
  process.exit(child.status ?? 1);
}

process.env.NO_PROXY = [
  process.env.NO_PROXY,
  "127.0.0.1",
  "localhost",
  "100.64.0.0/10",
  ".ts.net",
  ".tail6856d9.ts.net"
].filter(Boolean).join(",");

if (!webdriverSession) {
  console.error("Set CODEX_WEBDRIVER_SESSION to an already authenticated browser session.");
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

function round(value) {
  return Math.round(value * 100) / 100;
}

async function cookieHeader() {
  const response = await fetch(`${webdriverUrl}/session/${encodeURIComponent(webdriverSession)}/cookie`);
  if (!response.ok) throw new Error(`WebDriver cookie lookup failed with HTTP ${response.status}`);
  const payload = await response.json();
  const cookies = Array.isArray(payload.value) ? payload.value : [];
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  if (!cookie) throw new Error("The authenticated browser session has no cookies.");
  return cookie;
}

async function measuredFetch(path, cookie) {
  const startedAt = performance.now();
  try {
    const response = await fetch(new URL(path, baseUrl), {
      headers: { cookie },
      cache: "no-store"
    });
    const text = await response.text();
    return {
      status: response.status,
      ms: performance.now() - startedAt,
      text
    };
  } catch (error) {
    return {
      status: 0,
      ms: performance.now() - startedAt,
      text: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarize(samples) {
  const times = samples.map((sample) => sample.ms);
  return {
    requests: samples.length,
    ok: samples.filter((sample) => sample.status >= 200 && sample.status < 300).length,
    errors: samples.filter((sample) => sample.error).length,
    p50Ms: round(percentile(times, 0.5)),
    p95Ms: round(percentile(times, 0.95)),
    maxMs: round(Math.max(...times))
  };
}

function poolData(sample) {
  if (sample.status < 200 || sample.status >= 300) return null;
  try {
    return JSON.parse(sample.text).data;
  } catch {
    return null;
  }
}

async function main() {
  const cookie = await cookieHeader();
  const initialPool = await measuredFetch("/api/codex/account-pool", cookie);
  const initialData = poolData(initialPool);
  if (!initialData?.accounts?.length) {
    throw new Error(`Initial account-pool lookup failed with HTTP ${initialPool.status}${initialPool.error ? ` (${initialPool.error})` : ""}.`);
  }
  const initialChecks = Object.fromEntries(initialData.accounts.map((account) => [account.id, account.lastCheckedAt]));

  const projectsResponse = await measuredFetch("/api/projects", cookie);
  const projectsPayload = JSON.parse(projectsResponse.text);
  const project = projectsPayload.data?.find((entry) => entry.name === "我的工作区") ?? projectsPayload.data?.[0];
  if (!project?.id) throw new Error("No project was available for the list-latency probe.");
  const threadPath = `/api/projects/${encodeURIComponent(project.id)}/threads?fast=true`;

  // The live bridge intentionally coalesces force-refresh clicks for five
  // seconds. Wait out that cooldown so this burst proves a real refresh rather
  // than merely exercising the hot cache.
  await new Promise((resolve) => setTimeout(resolve, 5_100));

  const quotaPromise = Promise.all(Array.from({ length: quotaRequests }, () =>
    measuredFetch("/api/codex/account-pool?refresh=true", cookie)));
  const projectPromise = Promise.all(Array.from({ length: listRequests }, () =>
    measuredFetch("/api/projects", cookie)));
  const threadPromise = Promise.all(Array.from({ length: listRequests }, () =>
    measuredFetch(threadPath, cookie)));
  const [quotaSamples, projectSamples, threadSamples] = await Promise.all([quotaPromise, projectPromise, threadPromise]);

  const timestampSets = new Map();
  let validPoolPayloads = 0;
  for (const sample of quotaSamples) {
    const data = poolData(sample);
    if (!data?.accounts?.length) continue;
    validPoolPayloads += 1;
    for (const account of data.accounts) {
      const values = timestampSets.get(account.id) ?? new Set();
      values.add(account.lastCheckedAt);
      timestampSets.set(account.id, values);
    }
  }
  const refreshTimestamps = Object.fromEntries([...timestampSets].map(([id, values]) => [id, values.size]));
  const refreshedEveryAccount = initialData.accounts.every((account) => {
    const values = timestampSets.get(account.id);
    return values?.size === 1 && !values.has(initialChecks[account.id]);
  });
  const quota = summarize(quotaSamples);
  const projects = summarize(projectSamples);
  const threads = summarize(threadSamples);
  const passed = quota.ok === quota.requests
    && projects.ok === projects.requests
    && threads.ok === threads.requests
    && validPoolPayloads === quotaRequests
    && refreshedEveryAccount
    && projects.p95Ms < 1_000
    && threads.p95Ms < 1_000;

  console.log(JSON.stringify({
    passed,
    baseUrl: baseUrl.origin,
    quota,
    projects,
    threads,
    validPoolPayloads,
    refreshTimestamps,
    refreshedEveryAccount
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
