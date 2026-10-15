import { describe, expect, it } from "vitest";
import { notificationIsContextCompaction, RawCompactFilter } from "./rawNotificationFilter.js";

describe("RawCompactFilter", () => {
  it("hides compact reasoning and summary but allows recovery messages", () => {
    const filter = new RawCompactFilter();
    const threadId = "thread";
    const envelope = (method: string, params: Record<string, unknown> = {}) => ({
      method,
      params: { threadId, ...params }
    });

    expect(filter.observe(envelope("item/started", { item: { id: "compact", type: "ContextCompaction" } }))).toBe(true);
    expect(filter.observe(envelope("item/started", { item: { id: "reasoning", type: "Reasoning" } }))).toBe(true);
    expect(filter.observe(envelope("item/reasoning/summaryTextDelta", { itemId: "reasoning", delta: "thinking" }))).toBe(true);
    expect(filter.observe(envelope("item/completed", { item: { id: "reasoning", type: "Reasoning" } }))).toBe(true);
    expect(filter.observe(envelope("item/agentMessage/delta", { itemId: "summary", delta: "Summary" }))).toBe(true);
    expect(filter.observe(envelope("item/completed", { item: { id: "summary", type: "AgentMessage" } }))).toBe(true);
    expect(filter.observe(envelope("thread/compacted"))).toBe(true);
    expect(filter.observe(envelope("item/completed", { item: { id: "compact", type: "ContextCompaction" } }))).toBe(true);

    expect(filter.observe(envelope("item/started", { item: { id: "recovery-reasoning", type: "Reasoning" } }))).toBe(false);
    expect(filter.observe(envelope("item/agentMessage/delta", { itemId: "recovery", delta: "继续" }))).toBe(false);
  });

  it("suppresses a compact completion even when its started event was missed", () => {
    const filter = new RawCompactFilter();
    const event = {
      method: "item/completed",
      params: { threadId: "thread", item: { id: "compact", type: "ContextCompaction" } }
    };

    expect(filter.observe(event)).toBe(true);
    expect(filter.observe({ method: "thread/compacted", params: { threadId: "thread" } })).toBe(true);
  });

  it("uses repeated high-water usage as a compact candidate and allows recovery afterwards", () => {
    let currentTime = 0;
    const filter = new RawCompactFilter({
      candidateDelayMs: 0,
      now: () => currentTime
    });
    const threadId = "thread";
    const tokenEvent = () => ({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        tokenUsage: {
          last_token_usage: { total_tokens: 115_000 },
          model_context_window: 121_600
        }
      }
    });

    expect(filter.observe(tokenEvent())).toBe(false);

    currentTime = 6_000;
    expect(filter.observe(tokenEvent())).toBe(false);

    currentTime = 7_000;
    expect(filter.observe({
      method: "item/started",
      params: { threadId, item: { id: "reasoning", type: "Reasoning" } }
    })).toBe(true);
    expect(filter.observe({
      method: "item/reasoning/summaryTextDelta",
      params: { threadId, itemId: "reasoning", delta: "compact" }
    })).toBe(true);
    expect(filter.observe({
      method: "item/completed",
      params: { threadId, item: { id: "reasoning", type: "Reasoning" } }
    })).toBe(true);
    expect(filter.observe({
      method: "rawResponseItem/completed",
      params: { threadId, item: { id: "summary", type: "message" } }
    })).toBe(true);
    expect(filter.observe({ method: "thread/compacted", params: { threadId } })).toBe(true);
    expect(filter.observe({
      method: "item/completed",
      params: { threadId, item: { id: "compact", type: "ContextCompaction" } }
    })).toBe(true);
    expect(filter.observe({
      method: "item/started",
      params: { threadId, item: { id: "recovery", type: "Reasoning" } }
    })).toBe(false);
  });

  it("does not treat one high-water reading as compact output", () => {
    const filter = new RawCompactFilter({ candidateDelayMs: 0 });
    const threadId = "thread";

    expect(filter.observe({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        token_usage: {
          last_token_usage: { total_tokens: 115_000 },
          model_context_window: 121_600
        }
      }
    })).toBe(false);
    expect(filter.observe({
      method: "item/started",
      params: { threadId, item: { id: "normal", type: "Reasoning" } }
    })).toBe(false);
  });

  it("clears a candidate on compact failure", () => {
    let currentTime = 0;
    const filter = new RawCompactFilter({
      candidateDelayMs: 0,
      now: () => currentTime
    });
    const threadId = "thread";
    const tokenEvent = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        tokenUsage: {
          last_token_usage: { total_tokens: 115_000 },
          model_context_window: 121_600
        }
      }
    };

    filter.observe(tokenEvent);
    currentTime = 6_000;
    filter.observe(tokenEvent);
    currentTime = 7_000;
    expect(filter.observe({ method: "turn/failed", params: { threadId } })).toBe(false);
    expect(filter.observe({
      method: "item/started",
      params: { threadId, item: { id: "normal", type: "Reasoning" } }
    })).toBe(false);
  });

  it("allows tools and diffs and cancels a pending candidate", () => {
    let currentTime = 0;
    const filter = new RawCompactFilter({
      candidateDelayMs: 0,
      now: () => currentTime
    });
    const threadId = "thread";
    const tokenEvent = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        tokenUsage: {
          last_token_usage: { total_tokens: 115_000 },
          model_context_window: 121_600
        }
      }
    };

    filter.observe(tokenEvent);
    currentTime = 6_000;
    filter.observe(tokenEvent);
    currentTime = 7_000;

    expect(filter.observe({
      method: "item/started",
      params: { threadId, item: { id: "exec", type: "CommandExecution", command: "ls" } }
    })).toBe(false);
    expect(filter.observe({
      method: "item/started",
      params: { threadId, item: { id: "normal", type: "Reasoning" } }
    })).toBe(false);

    filter.observe(tokenEvent);
    currentTime = 13_000;
    filter.observe(tokenEvent);
    currentTime = 14_000;
    expect(filter.observe({ method: "turn/diff/updated", params: { threadId, diff: "diff" } })).toBe(false);
    expect(filter.observe({
      method: "item/started",
      params: { threadId, item: { id: "normal-2", type: "Reasoning" } }
    })).toBe(false);
  });

  it("expires an old candidate", () => {
    let currentTime = 0;
    const filter = new RawCompactFilter({
      candidateDelayMs: 0,
      candidateTtlMs: 600_000,
      now: () => currentTime
    });
    const threadId = "thread";
    const tokenEvent = {
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        tokenUsage: {
          last_token_usage: { total_tokens: 115_000 },
          model_context_window: 121_600
        }
      }
    };

    filter.observe(tokenEvent);
    currentTime = 6_000;
    filter.observe(tokenEvent);
    currentTime = 607_000;

    expect(filter.observe({
      method: "item/started",
      params: { threadId, item: { id: "normal", type: "Reasoning" } }
    })).toBe(false);
  });

  it("clears on turn completion and identifies compact item notifications", () => {
    const filter = new RawCompactFilter();
    const threadId = "thread";

    filter.markRequested(threadId);
    expect(filter.observe({ method: "turn/completed", params: { threadId } })).toBe(false);
    expect(filter.observe({
      method: "item/started",
      params: { threadId, item: { id: "compact", type: "ContextCompaction" } }
    })).toBe(true);

    expect(notificationIsContextCompaction({
      method: "item/completed",
      params: { threadId, item: { id: "compact", type: "ContextCompaction" } }
    })).toBe(true);
    expect(notificationIsContextCompaction({
      method: "item/completed",
      params: { threadId, item: { id: "exec", type: "CommandExecution" } }
    })).toBe(false);
  });
});
