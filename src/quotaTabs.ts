import type { ProviderQuotaView } from "../shared/providerQuota";

// MiMo remains usable in the model menu; only its quota tab is hidden.
export function visibleProviderQuotas(items: ProviderQuotaView[]): ProviderQuotaView[] {
  return items.filter(item => item.id !== "mimo").sort((a, b) =>
    Number(b.id === "ark") - Number(a.id === "ark") || a.id.localeCompare(b.id));
}
