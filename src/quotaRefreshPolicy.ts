import type { CodexAccountPool, CodexQuota } from './types';

export function quotaHasUsableRateLimits(quota: CodexQuota | null | undefined): boolean {
  const windows = [quota?.rateLimits?.primary, quota?.rateLimits?.secondary];
  if (windows.some(window => typeof window?.usedPercent === 'number')) return true;
  return Object.values(quota?.rateLimitsByLimitId ?? {}).some(snapshot => (
    typeof snapshot.primary?.usedPercent === 'number' || typeof snapshot.secondary?.usedPercent === 'number'
  ));
}

/** API providers have their own quota API, not Codex rate-limit fields. */
export function accountPoolNeedsQuotaRetry(pool: CodexAccountPool | null): boolean {
  if (!pool?.accounts.length) return true;
  return pool.accounts.some(account => account.kind !== 'api-provider' && !quotaHasUsableRateLimits(account.quota));
}
