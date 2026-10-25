import type { ProviderQuotaView } from "./providerQuota";

/** Cache only the public quota projection; never persist provider responses. */
export function cachedProviderQuota(raw: unknown, now = Date.now()): ProviderQuotaView | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as ProviderQuotaView;
  const date = typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : NaN;
  if (value.id !== "ark" || !Number.isFinite(date) || date > now + 60_000 || now - date > 7 * 86400_000 || !Array.isArray(value.periods)) return null;
  const periods = value.periods.slice(0, 3).flatMap(p => p && ["session", "weekly", "monthly"].includes(p.label) && typeof p.usedPercent === "number" && Number.isFinite(p.usedPercent) && p.usedPercent >= 0
    ? [{ label: p.label, usedPercent: p.usedPercent, resetsAt: typeof p.resetsAt === "string" && Number.isFinite(Date.parse(p.resetsAt)) ? p.resetsAt : null }] : []);
  if (!periods.length) return null;
  return { id: "ark", name: "Ark", status: "ready", periods, updatedAt: value.updatedAt, stale: true, message: null };
}

export function mergeProviderQuotaCache(previous: ProviderQuotaView[], incoming: ProviderQuotaView[], refreshing = false): ProviderQuotaView[] {
  return incoming.map(item => {
    const old = previous.find(p => p.id === item.id);
    const merged = !item.periods.length && old?.periods.length ? { ...old, status: item.status, stale: true, message: item.message } : item;
    return refreshing && merged.periods.length ? { ...merged, stale: true, message: merged.message ?? "正在后台更新额度…" } : merged;
  });
}
