import type { CodexAccountPool } from "./types";

export interface ExhaustedAccountSuggestion {
  threadId: string;
  sourceLabel: string;
  hasAvailableAlternative: boolean;
}

export function exhaustedAccountSuggestion(
  pool: CodexAccountPool,
  threadId: string
): ExhaustedAccountSuggestion | null {
  const source = pool.accounts.find((account) => account.id === pool.currentThreadAccountId);
  if (!threadId || !source) return null;
  const used = source.quota.rateLimits?.primary?.usedPercent;
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 90) return null;
  return {
    threadId,
    sourceLabel: source.label,
    hasAvailableAlternative: pool.accounts.some((account) => (
      account.id !== source.id
      && account.health !== "degraded"
      && typeof account.quota.rateLimits?.primary?.usedPercent === "number"
      && account.quota.rateLimits.primary.usedPercent < 100
    ))
  };
}
