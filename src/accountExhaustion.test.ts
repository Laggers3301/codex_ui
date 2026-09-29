import { describe, expect, it } from "vitest";
import { exhaustedAccountSuggestion } from "./accountExhaustion";
import type { CodexAccountPool, CodexAccountPoolAccount } from "./types";

function account(id: string, usedPercent: number | null, health: CodexAccountPoolAccount["health"] = "ready"): CodexAccountPoolAccount {
  return {
    id,
    label: id,
    health,
    selectedForNewThreads: false,
    assignedThreadCount: 0,
    activeRequests: 0,
    lastError: null,
    lastCheckedAt: null,
    quota: {
      account: null,
      rateLimits: {
        limitId: null,
        limitName: null,
        primary: usedPercent === null ? null : { usedPercent, resetsAt: null, windowDurationMins: null },
        secondary: null,
        credits: null,
        individualLimit: null,
        planType: null,
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: {},
      resetCredits: null,
      usage: null,
      errors: [],
      updatedAt: ""
    }
  };
}

describe("exhausted account suggestion", () => {
  it("uses the selected thread's assigned account, not the account selected for new chats", () => {
    const pool = {
      strategy: "highest-remaining-sticky-thread",
      currentThreadAccountId: "old",
      accounts: [account("old", 91), account("fresh", 42)],
      updatedAt: ""
    } satisfies CodexAccountPool;
    expect(exhaustedAccountSuggestion(pool, "thread-1")).toEqual({
      threadId: "thread-1",
      sourceLabel: "old",
      hasAvailableAlternative: true
    });
    expect(exhaustedAccountSuggestion({ ...pool, currentThreadAccountId: "fresh" }, "thread-1")).toBeNull();
    expect(exhaustedAccountSuggestion({ ...pool, accounts: [account("old", 90), account("fresh", 42)] }, "thread-1")).toBeNull();
  });

  it("does not treat missing quota as exhausted and disables migration when all alternatives are spent", () => {
    const pool = {
      strategy: "highest-remaining-sticky-thread",
      currentThreadAccountId: "old",
      accounts: [account("old", null), account("other", 100)],
      updatedAt: ""
    } satisfies CodexAccountPool;
    expect(exhaustedAccountSuggestion(pool, "thread-1")).toBeNull();
    expect(exhaustedAccountSuggestion({ ...pool, accounts: [account("old", 100), account("other", 100)] }, "thread-1")?.hasAvailableAlternative).toBe(false);
  });
});
