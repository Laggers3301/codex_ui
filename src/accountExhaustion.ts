import type { CodexAccountPool } from "./types";
import { codexHasAllowance, codexHasCredits, codexRemainingPercent } from "../shared/codexAllowance";

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
  const remaining = codexRemainingPercent(source.quota.rateLimits);
  if (remaining < 0 || remaining >= 10 || codexHasCredits(source.quota.rateLimits)) return null;
  return {
    threadId,
    sourceLabel: source.label,
    hasAvailableAlternative: pool.accounts.some((account) => (
      account.id !== source.id
      && account.health !== "degraded"
      && codexHasAllowance(account.quota.rateLimits)
    ))
  };
}
