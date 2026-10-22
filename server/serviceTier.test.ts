import { describe, expect, it } from "vitest";
import { requestedServiceTier, requestedTurnServiceTier } from "./serviceTier.js";

describe("native Fast preference", () => {
  it("passes Fast On to the runtime and the actual new turn", () => {
    expect(requestedServiceTier("fast")).toEqual({ serviceTier: "fast" });
    expect(requestedTurnServiceTier("fast")).toEqual({ serviceTier: "fast", serviceTierForTurn: "priority" });
  });
  it("explicitly clears saved Fast and overrides account defaults when off", () => {
    expect(requestedTurnServiceTier(null)).toEqual({ serviceTier: null, serviceTierForTurn: "default" });
  });
  it("preserves preferences for legacy clients and internal continuations", () => {
    expect(requestedServiceTier(undefined)).toEqual({});
    expect(requestedTurnServiceTier(undefined)).toEqual({});
  });
  it("rejects unsupported tiers rather than silently ignoring the toggle", () => {
    expect(() => requestedTurnServiceTier("ultrafast")).toThrow("Invalid serviceTier");
  });
});
