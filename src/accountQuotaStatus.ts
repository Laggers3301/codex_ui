import type { CodexAccountPoolAccount } from './types';

/** Cached quota is not proof of current authentication or current allowance. */
export function accountQuotaStatus(account: CodexAccountPoolAccount): 'ready' | 'cached' | 'unavailable' {
  if (account.health === 'ready') return 'ready';
  const errors = [account.lastError ?? '', ...account.quota.errors].join('\n');
  if (/refresh_token_(?:reused|invalidated)|invalid_grant|account_missing|登录失效|重新.*授权|需.*登录|401|403|unauthorized|forbidden/i.test(errors)) return 'unavailable';
  const windows = [account.quota.rateLimits?.primary, account.quota.rateLimits?.secondary];
  const usable = windows.some(w => typeof w?.usedPercent === 'number' && Number.isFinite(w.usedPercent));
  const transient = /timeout|timed out|超时|temporary|temporarily|ECONN|ENOTFOUND|EAI_AGAIN|network|TLS|fetch failed|connection|502|503|504/i.test(errors);
  return usable && transient ? 'cached' : 'unavailable';
}
