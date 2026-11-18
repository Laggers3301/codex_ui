import { describe, expect, it, vi } from "vitest";
import { requestedServiceTier, requestedTurnServiceTier } from "./serviceTier.js";
import { validateModelRequest } from "./modelRequestValidation.js";

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
  it("passes Ultra Fast distinctly from Fast to the actual turn", () => {
    expect(requestedServiceTier("ultrafast")).toEqual({ serviceTier: "ultrafast" });
    expect(requestedTurnServiceTier("ultrafast")).toEqual({ serviceTier: "ultrafast", serviceTierForTurn: "ultrafast" });
  });
  it("rejects unknown tiers rather than silently ignoring the selection", () => {
    expect(() => requestedTurnServiceTier("turbo")).toThrow("Invalid serviceTier");
  });
  it("blocks explicit Ultra Fast requests when disabled, including direct settings updates", () => {
    vi.stubEnv("CODEX_WEB_DISABLE_ULTRAFAST", "1");
    try {
      expect(() => requestedTurnServiceTier("ultrafast")).toThrow("已停用超快");
      expect(() => validateModelRequest("/unused", "thread/settings/update", { serviceTier: "ultrafast" })).toThrow("已停用超快");
      expect(requestedTurnServiceTier("fast")).toEqual({ serviceTier: "fast", serviceTierForTurn: "priority" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
