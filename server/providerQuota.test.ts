import { expect, it, vi } from "vitest";
import Fastify from "fastify";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArkQuota, ProviderQuotaCache, providerQuotaFailure, registerProviderQuotaRoutes } from "./providerQuota.js";
const payload = { viewer: { secret: "never-public", user_name: "private" }, items: [{ product: "coding-plan", subscribed: true, periods: [{ label: "session", percent: 17.88, reset_at: "2026-10-24T13:01:14+08:00" }, { label: "weekly", percent: 80.79 }] }] };
it("restores a bounded private success cache across restart and retains it after query failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "provider-quota-test-"));
  const file = path.join(directory, "quota.json");
  const now = Date.parse("2026-10-24T03:00:00Z");
  try {
    const cache = new ProviderQuotaCache(async () => payload, () => now, file);
    cache.snapshot();
    await vi.waitFor(() => expect(cache.snapshot().loading).toBe(false));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).not.toMatch(/secret|private|viewer/);
    const restored = new ProviderQuotaCache(async () => { throw new Error("secret"); }, () => now + 1000, file);
    expect(restored.snapshot().items[0]).toMatchObject({ periods: cache.snapshot().items[0].periods, stale: true });
    await vi.waitFor(() => expect(restored.snapshot().loading).toBe(false));
    expect(restored.snapshot().items[0].periods).toHaveLength(2);
    await writeFile(file, "invalid");
    // These assertions inspect restored state, not successful refreshes. A
    // successful background query would race the next fixture write/rename.
    const unavailable = async () => { throw new Error("fixture unavailable"); };
    expect(new ProviderQuotaCache(unavailable, () => now, file).snapshot().items[0].periods).toEqual([]);
    await writeFile(file, JSON.stringify(parseArkQuota(payload, "2026-09-01T00:00:00Z")));
    expect(new ProviderQuotaCache(unavailable, () => now, file).snapshot().items[0].periods).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("isolates a synchronous provider failure without throwing or exposing secrets", async () => {
  const query = vi.fn((): Promise<unknown> => { throw new Error("private credentials"); });
  const cache = new ProviderQuotaCache(query);
  expect(() => cache.snapshot()).not.toThrow();
  await vi.waitFor(() => expect(cache.snapshot().items[0].status).toBe("unavailable"));
  expect(query).toHaveBeenCalledOnce();
  expect(JSON.stringify(cache.snapshot())).not.toContain("private credentials");
});
it("only exposes validated percentages/dates, never viewer identity or raw CLI responses", () => {
  const quota = parseArkQuota(payload);
  expect(quota.periods).toHaveLength(2);
  expect(quota.periods[0].usedPercent).toBe(17.88);
  expect(JSON.stringify(quota)).not.toMatch(/private|never-public|viewer/);
  expect(() => parseArkQuota({ items: [{ product: "coding-plan", subscribed: true, periods: [{ label: "session", percent: NaN }] }] })).toThrow();
  expect(() => parseArkQuota({ items: [{ product: "coding-plan", subscribed: false, periods: [] }] })).toThrow();
});
it("coalesces concurrent viewers, refreshes at most once a minute and keeps stale data on failure", async () => {
  let now = 100_000, finish!: (value: unknown) => void;
  const query = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const cache = new ProviderQuotaCache(query, () => now);
  for (let n = 0; n < 50; n++) expect(cache.snapshot().loading).toBe(true);
  expect(query).toHaveBeenCalledOnce();
  finish(payload);
  await vi.waitFor(() => expect(cache.snapshot().loading).toBe(false));
  expect(cache.snapshot().items[0].status).toBe("ready");
  expect(query).toHaveBeenCalledOnce();
  now += 60_000;
  query.mockRejectedValueOnce(new Error("Bearer secret"));
  cache.snapshot();
  await vi.waitFor(() => expect(cache.snapshot().items[0].status).toBe("unavailable"));
  expect(cache.snapshot().items[0].stale).toBe(true);
  expect(cache.snapshot().items[0].periods).toHaveLength(2);
  expect(JSON.stringify(cache.snapshot())).not.toContain("secret");
});
it("checks the logged-in user before starting a control-plane query", async () => {
  const query = vi.fn(async () => payload), app = Fastify();
  registerProviderQuotaRoutes(app, request => { if (request.headers["x-user"] !== "member") throw Object.assign(new Error("Denied"), { statusCode: 401 }); }, new ProviderQuotaCache(query));
  try {
    expect((await app.inject({ url: "/api/codex/provider-quotas" })).statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
    const result = await app.inject({ url: "/api/codex/provider-quotas", headers: { "x-user": "member" } });
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json().data.items[1]).toMatchObject({ name: "MiMo", status: "auth_required", periods: [] });
    expect(query).toHaveBeenCalledOnce();
  } finally { await app.close(); }
});

it("runs native quota maintenance without viewers, with one in-flight request and clean shutdown", async () => {
  vi.useFakeTimers();
  let finish!: (value:unknown)=>void;
  const query=vi.fn(()=>new Promise(resolve=>{finish=resolve}));
  const cache=new ProviderQuotaCache(query);
  try {
    cache.start();cache.start();expect(query).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(180_000);expect(query).toHaveBeenCalledOnce();
    finish(payload);await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);expect(query).toHaveBeenCalledTimes(2);
    finish(payload);await vi.advanceTimersByTimeAsync(0);
    cache.stop();await vi.advanceTimersByTimeAsync(180_000);expect(query).toHaveBeenCalledTimes(2);
  } finally {cache.stop();vi.useRealTimers();}
});

it("distinguishes native reauthorization from network failures without exposing raw CLI output",()=>{
  expect(providerQuotaFailure({stderr:'{"error":{"message":"not logged in, SSO token expired"}}'})).toMatchObject({status:"auth_required",code:"sso_reauthorization_required"});
  expect(providerQuotaFailure({stderr:'invalid_grant Bearer do-not-print'})).toMatchObject({status:"auth_required",code:"sso_invalid_grant"});
  expect(JSON.stringify(providerQuotaFailure({stderr:'invalid_grant Bearer do-not-print'}))).not.toContain('do-not-print');
  expect(providerQuotaFailure({stderr:'ECONNRESET'})).toMatchObject({status:"unavailable",code:"query_network_error"});
  expect(providerQuotaFailure({killed:true})).toMatchObject({status:"unavailable",code:"query_timeout"});
});

it("preserves last successful quota on auth failure and reports recovery once, not renewal success",async()=>{
  let now=Date.parse('2026-10-26T00:00:00Z');const report=vi.fn();
  const query=vi.fn(async()=>payload);const cache=new ProviderQuotaCache(query,()=>now,undefined,report);
  cache.snapshot();await vi.waitFor(()=>expect(cache.snapshot().loading).toBe(false));
  query.mockRejectedValue(Object.assign(new Error('native failure'),{stderr:'not logged in, SSO token expired secret=hidden'}));
  now+=60000;cache.snapshot();await vi.waitFor(()=>expect(cache.snapshot().loading).toBe(false));
  expect(cache.snapshot().items[0]).toMatchObject({status:'auth_required',stale:true});expect(cache.snapshot().items[0].periods).toHaveLength(2);
  now+=60000;cache.snapshot();await vi.waitFor(()=>expect(cache.snapshot().loading).toBe(false));expect(report).toHaveBeenCalledOnce();
  query.mockResolvedValue(payload);now+=60000;cache.snapshot();await vi.waitFor(()=>expect(cache.snapshot().loading).toBe(false));
  expect(report).toHaveBeenCalledTimes(2);expect(report.mock.calls[1][0].event).toBe('quota_query_recovered');
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/hidden|token|renewed/);
});
