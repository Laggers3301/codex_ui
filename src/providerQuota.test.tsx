// @vitest-environment jsdom
import { expect, it } from "vitest";
import { cachedProviderQuota, mergeProviderQuotaCache } from "../shared/providerQuotaCache";
import { loadProviderQuotaCache } from "./providerQuota";
const quota = { id: "ark", name: "Ark", status: "ready" as const, periods: [{ label: "session", usedPercent: 32, resetsAt: null }], updatedAt: new Date().toISOString(), stale: false, message: null };
it("immediately restores only the current user's validated quota after page reload", () => {
  // Node 25's experimental global Storage shadows jsdom in this runner.
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    clear: () => storage.clear()
  } });
  window.localStorage.clear();
  window.localStorage.setItem("codex-provider-quota:v1:alice", JSON.stringify({ ...quota, viewer: "private", token: "secret" }));
  expect(loadProviderQuotaCache("alice")[0]).toMatchObject({ periods: quota.periods, stale: true });
  expect(JSON.stringify(loadProviderQuotaCache("alice"))).not.toMatch(/private|secret/);
  expect(loadProviderQuotaCache("bob")).toEqual([]);
  window.localStorage.setItem("codex-provider-quota:v1:alice", "invalid");
  expect(loadProviderQuotaCache("alice")).toEqual([]);
});
it("never blanks successful values during loading or failures, but accepts fresh values including zero", () => {
  const loading = { ...quota, status: "loading" as const, periods: [], updatedAt: null };
  expect(mergeProviderQuotaCache([quota], [loading], true)[0]).toMatchObject({ periods: quota.periods, stale: true });
  expect(mergeProviderQuotaCache([quota], [{ ...loading, status: "unavailable" }])[0].periods).toEqual(quota.periods);
  expect(mergeProviderQuotaCache([quota], [{ ...quota, periods: [{ label: "session", usedPercent: 100, resetsAt: null }] }])[0].periods[0].usedPercent).toBe(100);
  expect(cachedProviderQuota({ ...quota, updatedAt: "2020-01-01" })).toBeNull();
  expect(cachedProviderQuota({ ...quota, periods: [{ label: "session", usedPercent: NaN }] })).toBeNull();
});
