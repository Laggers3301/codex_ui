import { useEffect, useState } from "react";
import type { ProviderQuotaPeriod, ProviderQuotaView } from "../shared/providerQuota";
import "./providerQuota.css";
import { cachedProviderQuota, mergeProviderQuotaCache } from "../shared/providerQuotaCache";

export function loadProviderQuotaCache(userId: string): ProviderQuotaView[] {
  try {
    const raw = window.localStorage.getItem(`codex-provider-quota:v1:${userId}`);
    const cached = raw && raw.length <= 16_384 ? cachedProviderQuota(JSON.parse(raw)) : null;
    return cached ? [cached] : [];
  } catch { return []; }
}

export function useProviderQuotas(userId: string) {
  const [items, setItems] = useState<ProviderQuotaView[]>(() => loadProviderQuotaCache(userId));
  useEffect(() => {
    setItems(loadProviderQuotaCache(userId));
    const abort = new AbortController();
    let timer: number | undefined, attempts = 0;
    const load = async () => {
      try {
        const response = await fetch("/api/codex/provider-quotas", { credentials: "same-origin", signal: abort.signal });
        if (!response.ok) throw new Error("Quota request failed");
        const body = await response.json();
        if (abort.signal.aborted) return;
        if (Array.isArray(body.data?.items)) {
          setItems(previous => mergeProviderQuotaCache(previous, body.data.items, Boolean(body.data.loading)));
          const cached = cachedProviderQuota(body.data.items.find((item: ProviderQuotaView) => item.id === "ark"));
          if (cached) try { window.localStorage.setItem(`codex-provider-quota:v1:${userId}`, JSON.stringify(cached)); } catch { /* Storage may be disabled. */ }
        }
        if (body.data?.loading && ++attempts < 25) timer = window.setTimeout(load, 1500);
        else timer = window.setTimeout(() => { attempts = 0; void load(); }, 60_000);
      } catch {
        if (abort.signal.aborted) return;
        setItems(previous => previous.map(item => item.periods.length ? { ...item, stale: true, message: "额度更新暂不可用，保留上次成功值。" } : item));
        timer = window.setTimeout(load, 15_000);
      }
    };
    void load();
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [userId]);
  return items;
}

export function providerRemaining(item: ProviderQuotaView): string {
  const period = item.periods.find(p => p.label === "session") ?? item.periods[0];
  return period ? `${Math.round(Math.max(0, 100 - period.usedPercent))}%` : item.status === "loading" ? "…" : "--";
}

export function ProviderQuotaDetails({ item, formatPeriod }: { item: ProviderQuotaView; formatPeriod: (period: ProviderQuotaPeriod) => string }) {
  return <div className="providerQuotaDetails" role="tabpanel" aria-label={`${item.name} quota`}>
    <div className="quotaPopoverRows">{item.periods.map(period => <div key={period.label}>
      <span>{({ session: "主额度", weekly: "次额度", monthly: "月额度" } as Record<string, string>)[period.label] ?? period.label}</span>
      <strong>{formatPeriod(period)}</strong>
    </div>)}</div>
    {item.message ? <p>{item.message}</p> : !item.periods.length ? <p>正在读取官方套餐用量…</p> : null}
    {item.updatedAt ? <p className="providerQuotaUpdated">{item.stale ? "缓存 · " : ""}更新于 {new Date(item.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</p> : null}
  </div>;
}
