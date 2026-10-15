import { describe, expect, it } from "vitest";
import { advanceTrackedQuotaLedger, type TrackedQuotaLedgerSnapshot } from "./trackedQuotaLedger.js";

const initial: TrackedQuotaLedgerSnapshot = {
  resetAt: 123456,
  quotaPercent: 60,
  totalTokens: 1_000,
  userTokens: 500,
  dailyUserTokens: { "2026-09-28": 500 },
  observedAt: 1_000
};

describe("tracked quota incremental attribution", () => {
  it("preserves accrued quota through reset drift and a deduplicated token baseline", () => {
    const seeded = advanceTrackedQuotaLedger(null, initial, { cyclePercent: 78, dailyPercent: { "2026-09-28": 78 } });
    const corrected = advanceTrackedQuotaLedger(seeded, { ...initial, resetAt: initial.resetAt + 2, totalTokens: 800, observedAt: 2000 }, { cyclePercent: 29, dailyPercent: {} });
    expect(corrected.userCycleQuotaPercent).toBe(78);
    expect(corrected.observedTotalTokens).toBe(800);
    const next = advanceTrackedQuotaLedger(corrected, { ...initial, resetAt: initial.resetAt + 2, quotaPercent: 65, totalTokens: 900, userTokens: 600, observedAt: 3000 }, { cyclePercent: 0, dailyPercent: {} });
    expect(next.userCycleQuotaPercent).toBe(83);
  });
  it("does not reduce a user's accrued percentage when others continue using the account", () => {
    const seeded = advanceTrackedQuotaLedger(null, initial, {
      cyclePercent: 50,
      dailyPercent: { "2026-09-28": 50 }
    });
    const others = advanceTrackedQuotaLedger(seeded, {
      ...initial,
      quotaPercent: 70,
      totalTokens: 1_200,
      observedAt: 2_000
    }, { cyclePercent: 0, dailyPercent: {} });
    expect(others.userCycleQuotaPercent).toBe(50);
    expect(others.dailyQuotaPercent["2026-09-28"]).toBe(50);

    const onlyUser = advanceTrackedQuotaLedger(others, {
      ...initial,
      quotaPercent: 80,
      totalTokens: 1_300,
      userTokens: 600,
      dailyUserTokens: { "2026-09-28": 600 },
      observedAt: 3_000
    }, { cyclePercent: 0, dailyPercent: {} });
    expect(onlyUser.userCycleQuotaPercent).toBe(60);
    expect(onlyUser.dailyQuotaPercent["2026-09-28"]).toBe(60);

    const concurrent = advanceTrackedQuotaLedger(onlyUser, {
      ...initial,
      quotaPercent: 90,
      totalTokens: 1_500,
      userTokens: 700,
      dailyUserTokens: { "2026-09-28": 700 },
      observedAt: 4_000
    }, { cyclePercent: 0, dailyPercent: {} });
    expect(concurrent.userCycleQuotaPercent).toBe(65);
    expect(concurrent.dailyQuotaPercent["2026-09-28"]).toBe(65);
  });

  it("waits briefly for usage logs and ignores downward quota corrections", () => {
    const seeded = advanceTrackedQuotaLedger(null, initial, { cyclePercent: 20, dailyPercent: {} });
    const waiting = advanceTrackedQuotaLedger(seeded, {
      ...initial,
      quotaPercent: 65,
      observedAt: 2_000
    }, { cyclePercent: 0, dailyPercent: {} });
    expect(waiting.userCycleQuotaPercent).toBe(20);
    expect(waiting.pendingQuotaPercent).toBe(5);
    const caughtUp = advanceTrackedQuotaLedger(waiting, {
      ...initial,
      quotaPercent: 64,
      totalTokens: 1_050,
      userTokens: 550,
      dailyUserTokens: { "2026-09-28": 550 },
      observedAt: 3_000
    }, { cyclePercent: 0, dailyPercent: {} });
    expect(caughtUp.userCycleQuotaPercent).toBe(25);
    expect(caughtUp.observedQuotaPercent).toBe(65);
  });

  it("starts a fresh ledger only when the official reset window changes", () => {
    const seeded = advanceTrackedQuotaLedger(null, initial, { cyclePercent: 50, dailyPercent: {} });
    const reset = advanceTrackedQuotaLedger(seeded, {
      ...initial,
      resetAt: 999999,
      quotaPercent: 2,
      observedAt: 5_000
    }, { cyclePercent: 1, dailyPercent: { "2026-09-28": 1 } });
    expect(reset.userCycleQuotaPercent).toBe(1);
  });
});
