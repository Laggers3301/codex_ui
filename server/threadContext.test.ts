import { describe, expect, it } from "vitest";
import {
  contextWindowMeasuredForConfig,
  resolveThreadContextConfig,
  threadContextFeatureEnabled,
  threadContextConfigOverrides,
  threadTurnContextConfigOverrides
} from "./threadContext.js";

describe("thread context profiles", () => {
  it("keeps the master switch disabled by default and restores native defaults", () => {
    expect(threadContextFeatureEnabled).toBe(false);
    expect(threadContextConfigOverrides({
      threadId: "thread-untouched",
      profile: "default",
      contextWindow: null,
      compactTokenLimit: null,
      scope: "total",
      updatedAt: null
    })).toEqual({});
    const config = resolveThreadContextConfig("thread-default", { profile: "default" });
    expect(config).toMatchObject({ contextWindow: null, compactTokenLimit: null });
    expect(threadContextConfigOverrides(config)).toEqual({});
  });

  it("retains profile code but does not inject it while the switch is off", () => {
    const config = resolveThreadContextConfig("thread-maximum", { profile: "maximum" });
    expect(config).toMatchObject({ contextWindow: 1_000_000, compactTokenLimit: 900_000 });
    expect(threadContextConfigOverrides(config)).toEqual({});
  });

  it("rejects custom compact thresholds without safe headroom", () => {
    expect(() => resolveThreadContextConfig("thread-custom", {
      profile: "custom",
      contextWindow: 200_000,
      compactTokenLimit: 190_000,
      scope: "total"
    })).toThrow(/90%/);
  });

  it("ignores observed caps while the feature is disabled", () => {
    const config = resolveThreadContextConfig("thread-capped", { profile: "maximum" });
    expect(threadContextConfigOverrides(config, 258_400)).toEqual({});
  });

  it("sends explicit nulls to turn/start when restoring model defaults", () => {
    expect(threadTurnContextConfigOverrides({
      threadId: "thread-balanced",
      profile: "balanced",
      contextWindow: null,
      compactTokenLimit: 225_000,
      scope: "total",
      updatedAt: null
    })).toEqual({
      model_context_window: null,
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: "total"
    });
    expect(threadTurnContextConfigOverrides(null)).toEqual({
      model_context_window: null,
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: "total"
    });
  });

  it("does not reuse a context-window measurement captured before the preference changed", () => {
    const config = {
      ...resolveThreadContextConfig("thread-reset", { profile: "default" }),
      updatedAt: "2026-08-30T15:00:00.000Z"
    };
    expect(contextWindowMeasuredForConfig(config, {
      contextWindow: 95_000,
      lastTokenCountAt: "2026-08-30T14:59:59.000Z"
    })).toBeNull();
    expect(contextWindowMeasuredForConfig(config, {
      contextWindow: 258_400,
      lastTokenCountAt: "2026-08-30T15:00:01.000Z"
    })).toBe(258_400);
  });
});
