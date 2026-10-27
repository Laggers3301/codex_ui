import { expect, it } from 'vitest';
import type { CodexAccountPoolAccount } from './types';
import { accountQuotaStatus } from './accountQuotaStatus';
const account = {health:'degraded',lastError:'rateLimits: request timed out',quota:{errors:[],rateLimits:{primary:{usedPercent:25}}}} as unknown as CodexAccountPoolAccount;
it('distinguishes usable cached quota from failed authentication and unknown availability',()=>{
  expect(accountQuotaStatus(account)).toBe('cached');
  for (const error of ['refresh_token_reused','refresh_token_invalidated','invalid_grant','登录失效，请重新授权','HTTP 401','unknown failure']) {
    expect(accountQuotaStatus({...account,lastError:error})).toBe('unavailable');
  }
  expect(accountQuotaStatus({...account,health:'ready'})).toBe('ready');
  expect(accountQuotaStatus({...account,quota:{...account.quota,rateLimits:null}})).toBe('unavailable');
});
