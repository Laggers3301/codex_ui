export type TrackedQuotaLedgerAccount = {
  resetAt: number;
  observedQuotaPercent: number;
  observedTotalTokens: number;
  observedUserTokens: number;
  observedDailyTokens: Record<string, number>;
  userCycleQuotaPercent: number;
  dailyQuotaPercent: Record<string, number>;
  pendingQuotaPercent: number;
  pendingSince: number | null;
};

export type TrackedQuotaLedgerSnapshot = {
  resetAt: number;
  quotaPercent: number;
  totalTokens: number;
  userTokens: number;
  dailyUserTokens: Record<string, number>;
  observedAt: number;
};

const pendingMaxAgeMs = 2 * 60_000;

function boundedPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function advanceTrackedQuotaLedger(
  previous: TrackedQuotaLedgerAccount | null,
  snapshot: TrackedQuotaLedgerSnapshot,
  initial: { cyclePercent: number; dailyPercent: Record<string, number> }
): TrackedQuotaLedgerAccount {
  if (!previous || Math.abs(previous.resetAt - snapshot.resetAt) > 5 * 60) {
    return {
      resetAt: snapshot.resetAt,
      observedQuotaPercent: boundedPercent(snapshot.quotaPercent),
      observedTotalTokens: snapshot.totalTokens,
      observedUserTokens: snapshot.userTokens,
      observedDailyTokens: { ...snapshot.dailyUserTokens },
      userCycleQuotaPercent: boundedPercent(initial.cyclePercent),
      dailyQuotaPercent: { ...initial.dailyPercent },
      pendingQuotaPercent: 0,
      pendingSince: null
    };
  }

  // Corrected history (e.g. removed inherited fork usage) changes the token
  // baseline, never already-accrued quota. Otherwise future genuine use would
  // be ignored until it caught up with the old inflated denominator.
  if (snapshot.totalTokens < previous.observedTotalTokens || snapshot.userTokens < previous.observedUserTokens) {
    previous = { ...previous, observedTotalTokens: snapshot.totalTokens,
      observedUserTokens: snapshot.userTokens, observedDailyTokens: { ...snapshot.dailyUserTokens } };
  }

  const quotaIncrease = Math.max(0, snapshot.quotaPercent - previous.observedQuotaPercent);
  const totalTokenIncrease = Math.max(0, snapshot.totalTokens - previous.observedTotalTokens);
  const userTokenIncrease = Math.max(0, snapshot.userTokens - previous.observedUserTokens);
  const dailyTokenIncrease = Object.fromEntries(
    Object.entries(snapshot.dailyUserTokens)
      .map(([day, tokens]) => [day, Math.max(0, tokens - (previous.observedDailyTokens[day] ?? 0))])
  );
  const pendingExpired = previous.pendingSince !== null
    && snapshot.observedAt - previous.pendingSince > pendingMaxAgeMs;
  const pending = pendingExpired ? 0 : previous.pendingQuotaPercent;
  const distributable = quotaIncrease + pending;
  const dailyQuotaPercent = { ...previous.dailyQuotaPercent };
  let userCycleQuotaPercent = previous.userCycleQuotaPercent;

  if (distributable > 0 && totalTokenIncrease > 0) {
    // In a single-user interval, the account's measured quota change is assigned
    // in full. Concurrent use can only be estimated from the newly recorded work.
    const userIncrease = Math.min(distributable, distributable * userTokenIncrease / totalTokenIncrease);
    userCycleQuotaPercent = boundedPercent(userCycleQuotaPercent + userIncrease);
    const dailyTotal = Object.values(dailyTokenIncrease).reduce((sum, tokens) => sum + tokens, 0);
    if (dailyTotal > 0) {
      for (const [day, tokens] of Object.entries(dailyTokenIncrease)) {
        dailyQuotaPercent[day] = boundedPercent((dailyQuotaPercent[day] ?? 0) + userIncrease * tokens / dailyTotal);
      }
    }
    return {
      ...previous,
      resetAt: snapshot.resetAt,
      observedQuotaPercent: Math.max(previous.observedQuotaPercent, snapshot.quotaPercent),
      observedTotalTokens: Math.max(previous.observedTotalTokens, snapshot.totalTokens),
      observedUserTokens: Math.max(previous.observedUserTokens, snapshot.userTokens),
      observedDailyTokens: { ...snapshot.dailyUserTokens },
      userCycleQuotaPercent,
      dailyQuotaPercent,
      pendingQuotaPercent: 0,
      pendingSince: null
    };
  }

  return {
    ...previous,
    resetAt: snapshot.resetAt,
    observedQuotaPercent: Math.max(previous.observedQuotaPercent, snapshot.quotaPercent),
    // Hold token deltas until the corresponding official quota reading arrives.
    // A quota change without local usage is left pending briefly for JSONL lag.
    pendingQuotaPercent: distributable,
    pendingSince: distributable > 0 ? (pendingExpired || previous.pendingSince === null ? snapshot.observedAt : previous.pendingSince) : null
  };
}
