import { useEffect, useState } from "react";
import type { ProviderQuotaPeriod, ProviderQuotaView } from "../shared/providerQuota";
import "./providerQuota.css";
import { cachedProviderQuota, mergeProviderQuotaCache } from "../shared/providerQuotaCache";
import { exhaustedProviderPeriod, providerQuotaRestriction } from "../shared/providerQuota";
import { providerFailureCopy, type ProviderFailureNotice } from "./providerFailure";

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
  // Every window must allow the request. Never advertise 100% availability
  // just because the short window reset while the weekly window is exhausted.
  const periods = item.periods.filter(p => !p.resetsAt || Date.parse(p.resetsAt) > Date.now());
  return periods.length ? `${Math.round(Math.max(0, Math.min(100, ...periods.map(p => 100 - p.usedPercent))))}%` : item.status === "loading" ? "…" : "--";
}

export function ProviderQuotaDetails({ item, formatPeriod }: { item: ProviderQuotaView; formatPeriod: (period: ProviderQuotaPeriod) => string }) {
  const restriction = providerQuotaRestriction(item);
  const exhausted = exhaustedProviderPeriod(item);
  return <div className="providerQuotaDetails" role="tabpanel" aria-label={`${item.name} quota`}>
    {restriction ? <p className="providerQuotaRestriction" role="status" title={restriction}>{item.stale ? "缓存 · " : ""}{({session:"五小时",weekly:"每周",monthly:"每月"} as Record<string,string>)[exhausted!.label] ?? "套餐"}额度已耗尽 · 当前不可用</p> : null}
    <div className="quotaPopoverRows">{item.periods.map(period => <div key={period.label}>
      <span>{({ session: "5h", weekly: "Weekly", monthly: "Monthly" } as Record<string, string>)[period.label] ?? period.label}</span>
      <strong title={formatPeriod(period)}>
        <span className="providerQuotaBalance">剩余 {Math.round(Math.max(0,100-period.usedPercent)*10)/10}%<span>已用 {Math.round(period.usedPercent*10)/10}%</span></span>
        {period.resetsAt ? <span className="providerQuotaReset">重置 {new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(period.resetsAt))}</span> : null}
      </strong>
    </div>)}
    {item.updatedAt ? <div className="providerQuotaUpdated"><span>更新时间</span><strong>{item.stale ? "缓存 · " : ""}{new Date(item.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}</strong></div> : null}
    </div>
    {item.message ? <p>{item.message}</p> : !item.periods.length ? <p>正在读取官方套餐用量…</p> : null}
  </div>;
}

function ArkFailureSummary({ notice, userId }: { notice: ProviderFailureNotice; userId: string }) {
  const quotas = useProviderQuotas(userId);
  const item = quotas.find(q => q.id === "ark");
  const fresh = item?.updatedAt && Date.now() - Date.parse(item.updatedAt) < 120_000 && item.status === "ready";
  const restriction = item && fresh ? providerQuotaRestriction(item) : null;
  const copy = providerFailureCopy(notice);
  return <span>{restriction ? `${notice.model}：${restriction}（官方额度查询）` : `${copy.title}：${copy.message}`}</span>;
}

export function ProviderFailureSummary({ notice, userId }: { notice: ProviderFailureNotice; userId: string }) {
  // Only corroborate unknown Ark limits. Never turn an auth/network/model error
  // into quota exhaustion, or infer exhaustion from a stale browser cache.
  if (notice.httpStatusCode === 429 && /^(kimi-|doubao-|glm-|deepseek-|minimax-)/.test(notice.model) && notice.kind === "limit" && notice.limitType !== "rate") {
    return <ArkFailureSummary notice={notice} userId={userId} />;
  }
  const copy = providerFailureCopy(notice);
  return <span>{copy.title}：{copy.message}</span>;
}
