export interface ProviderQuotaPeriod { label: string; usedPercent: number; resetsAt: string | null }
export interface ProviderQuotaView {
  id: string; name: string; status: "ready" | "loading" | "auth_required" | "unavailable";
  periods: ProviderQuotaPeriod[]; updatedAt: string | null; stale: boolean; message: string | null;
}
