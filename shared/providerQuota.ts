export interface ProviderQuotaPeriod { label: string; usedPercent: number; resetsAt: string | null }
export interface ProviderQuotaView {
  id: string; name: string; status: "ready" | "loading" | "auth_required" | "unavailable";
  periods: ProviderQuotaPeriod[]; updatedAt: string | null; stale: boolean; message: string | null;
}

export function exhaustedProviderPeriod(item: ProviderQuotaView, now = Date.now()): ProviderQuotaPeriod | undefined {
  return item.periods.find(p => p.usedPercent >= 100 && (!p.resetsAt || Date.parse(p.resetsAt) > now));
}

export function providerQuotaRestriction(item: ProviderQuotaView, now = Date.now()): string | null {
  const p = exhaustedProviderPeriod(item, now);
  if (!p) return null;
  const label = ({session:"五小时",weekly:"每周",monthly:"每月"} as Record<string,string>)[p.label] ?? p.label;
  const reset = p.resetsAt ? new Intl.DateTimeFormat("zh-CN", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(p.resetsAt)) : null;
  return `${label}额度已耗尽，当前不可用${reset ? `；重置时间：${reset}（北京时间）` : "，等待额度重置"}。`;
}
