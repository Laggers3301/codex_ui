const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

function snapshot(value: unknown): Record<string, unknown> {
  const root = record(value);
  return root.rateLimits ? record(root.rateLimits) : root;
}

/** Either subscription window can prevent a request, even with 5h quota left. */
export function codexRemainingPercent(value: unknown): number {
  const limits = snapshot(value);
  const used = [limits.primary, limits.secondary].map(window => record(window).usedPercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return used.length ? Math.max(0, Math.min(100, 100 - Math.max(...used))) : -1;
}

export function codexHasCredits(value: unknown): boolean {
  const credits = record(snapshot(value).credits);
  if (credits.unlimited === true) return true;
  if (credits.hasCredits === false) return false;
  if (typeof credits.balance === "string" && credits.balance.trim()) {
    const balance = Number(credits.balance);
    return Number.isFinite(balance) && balance > 0;
  }
  return credits.hasCredits === true;
}

export function codexHasAllowance(value: unknown): boolean {
  return codexRemainingPercent(value) > 0 || codexHasCredits(value);
}
