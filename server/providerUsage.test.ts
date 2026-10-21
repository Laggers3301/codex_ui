import { describe, expect, it } from "vitest";
import { normalizeProviderUsage as norm, ProviderUsageTracker } from "./providerUsage.js";
describe("provider usage accounting", () => {
  it("preserves native counters and nested Responses/Chat details without double billing", () => {
    const expected = { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 20, totalTokens: 130 };
    expect(norm({ input_tokens: 100, cached_input_tokens: 60, output_tokens: 30, reasoning_output_tokens: 20, total_tokens: 130 })).toEqual(expected);
    expect(norm({ input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 } })).toEqual(expected);
    expect(norm({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } })).toEqual(expected);
  });
  it("includes Anthropic separately reported cache input once", () => {
    expect(norm({ input_tokens: 10, cache_read_input_tokens: 60, cache_creation_input_tokens: 30, output_tokens: 5 })).toEqual({ inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 30, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 105 });
  });
  it("does not invent counts from missing, negative, infinite or string values", () => {
    expect(norm({ input_tokens: -1, output_tokens: Infinity, total_tokens: "9", reasoning_tokens: 100 }).totalTokens).toBe(0);
    expect(norm({ input_tokens: 5, cached_input_tokens: 9, output_tokens: 2, reasoning_tokens: 8 })).toMatchObject({ cachedInputTokens: 5, reasoningOutputTokens: 2, totalTokens: 7 });
  });
  it("differences cumulative snapshots and suppresses repeated telemetry", () => {
    const tracker = new ProviderUsageTracker();
    expect(tracker.consume({ total_token_usage: { input_tokens: 100, output_tokens: 10 } })?.totalTokens).toBe(110);
    expect(tracker.consume({ total_token_usage: { input_tokens: 100, output_tokens: 10 } })).toBeNull();
    expect(tracker.consume({ total_token_usage: { input_tokens: 150, output_tokens: 20 } })).toMatchObject({ inputTokens: 50, outputTokens: 10, totalTokens: 60 });
    expect(tracker.consume({ total_token_usage: { input_tokens: 5, output_tokens: 2 } })?.totalTokens).toBe(7);
  });
  it("does not deduplicate distinct equally-sized requests without a cumulative identity", () => {
    const tracker = new ProviderUsageTracker();
    for (let i = 0; i < 2; i++) expect(tracker.consume({ last_token_usage: { input_tokens: 3, output_tokens: 2 } })?.totalTokens).toBe(5);
    expect(tracker.consume(null)).toBeNull();
  });
});
