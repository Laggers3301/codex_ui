import { describe, expect, it } from 'vitest';
import { accountPoolNeedsQuotaRetry } from './quotaRefreshPolicy';
import type { CodexAccountPool } from './types';

const pool = (accounts: unknown[]) => ({ accounts } as CodexAccountPool);
const gpt = (usedPercent: number | null, kind: string | undefined = 'codex-account') => ({ kind, quota: { rateLimits: { primary: { usedPercent } }, rateLimitsByLimitId: {} } });
const provider = { kind: 'api-provider', quota: { rateLimits: null, rateLimitsByLimitId: {} } };

describe('quota polling retry policy', () => {
  it('does not force GPT refresh just because API providers have different quota fields', () => {
    expect(accountPoolNeedsQuotaRetry(pool([gpt(0), gpt(100), provider, provider, provider]))).toBe(false);
  });
  it('retries when a real GPT account has no usable quota or the pool has not loaded', () => {
    expect(accountPoolNeedsQuotaRetry(null)).toBe(true);
    expect(accountPoolNeedsQuotaRetry(pool([]))).toBe(true);
    expect(accountPoolNeedsQuotaRetry(pool([gpt(null), provider]))).toBe(true);
    expect(accountPoolNeedsQuotaRetry(pool([{ quota: { rateLimits: null, rateLimitsByLimitId: {} } }]))).toBe(true);
    expect(accountPoolNeedsQuotaRetry(pool([provider]))).toBe(false);
  });
  it('accepts a named limit when the primary window is absent', () => {
    expect(accountPoolNeedsQuotaRetry(pool([{ quota: { rateLimits: null, rateLimitsByLimitId: { other: { primary: { usedPercent: 25 } } } } }]))).toBe(false);
  });
});
