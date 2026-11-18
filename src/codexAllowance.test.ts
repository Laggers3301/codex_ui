import { expect, it } from "vitest";
import { codexHasAllowance, codexHasCredits, codexRemainingPercent } from "../shared/codexAllowance";

it("checks both subscription windows and explicit Credits without treating unknown quota as available", () => {
  const limits = { primary: { usedPercent: 25 }, secondary: { usedPercent: 100 } };
  expect(codexRemainingPercent({ rateLimits: limits })).toBe(0);
  expect(codexHasAllowance(limits)).toBe(false);
  expect(codexHasAllowance({ ...limits, credits: { balance: "3.50" } })).toBe(true);
  for (const credits of [{ balance: "0", hasCredits: true }, { balance: "-2" }, { balance: "NaN" }, { hasCredits: false, balance: "20" }, null]) {
    expect(codexHasCredits({ credits })).toBe(false);
  }
  expect(codexHasCredits({ credits: { unlimited: true } })).toBe(true);
  expect(codexHasCredits({ credits: { hasCredits: true } })).toBe(true);
  expect(codexHasAllowance(null)).toBe(false);
});
