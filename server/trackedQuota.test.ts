import { describe, expect, it } from "vitest";
import { estimatedQuotaPercent } from "./routes.js";

describe("tracked quota estimation", () => {
  it("attributes an account's observed quota decline by token share", () => {
    expect(estimatedQuotaPercent(250, 1_000, 40)).toBe(10);
    expect(estimatedQuotaPercent(1, 3, 10)).toBe(3.33);
  });

  it("returns zero when the account has no usable quota snapshot", () => {
    expect(estimatedQuotaPercent(250, 0, 40)).toBe(0);
    expect(estimatedQuotaPercent(250, 1_000, null)).toBe(0);
    expect(estimatedQuotaPercent(0, 1_000, 40)).toBe(0);
  });
});
