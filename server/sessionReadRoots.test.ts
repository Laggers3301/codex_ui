import { describe, expect, it } from "vitest";
import { accountHistoryRoots } from "./sessionReadRoots.js";

describe("account history read allowlist", () => {
  it("includes disabled configured accounts without changing execution flags", () => {
    const config = { accounts: [{ codexHome: '/configured/active', enabled: true }, { codexHome: '/configured/disabled', enabled: false }] };
    expect(accountHistoryRoots(config)).toEqual(['/configured/active/sessions','/configured/disabled/sessions']);
    expect(config.accounts[1].enabled).toBe(false);
  });
  it("rejects malformed and relative homes", () => {
    expect(accountHistoryRoots({ accounts: [null, { codexHome: '../../outside' }, { codexHome: 123 }] })).toEqual([]);
    expect(accountHistoryRoots(null)).toEqual([]);
  });
});
