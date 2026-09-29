import { describe, expect, it } from "vitest";
import { apiLeaderboardCycleWindow, mergeAccountLeaderboards, usageInLeaderboardCycle, userIdFromSessionCwd } from "./routes.js";

const tokens = (totalTokens: number) => ({
  inputTokens: totalTokens,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens
});

describe("API-provider leaderboard usage", () => {
  it("counts API events by timestamp in the visible GPT quota window", () => {
    const window = apiLeaderboardCycleWindow([
      { resetAt: 1_000_000, resetWindowMins: 60 },
      { resetAt: 1_000_600, resetWindowMins: 60 }
    ], 999_000);
    expect(window).toEqual({ startAt: 996_400, resetAt: 1_000_600, resetWindowMins: null });
    expect(usageInLeaderboardCycle({ resetAt: null, occurredAt: 996_400 }, "api-provider", window)).toBe(true);
    expect(usageInLeaderboardCycle({ resetAt: null, occurredAt: 1_000_600 }, "api-provider", window)).toBe(false);
    expect(usageInLeaderboardCycle({ resetAt: null, occurredAt: null }, "api-provider", window)).toBe(false);
    expect(usageInLeaderboardCycle({ resetAt: 1_000_000 }, "codex-account", window)).toBe(false);
  });

  it("accepts small GPT reset drift but rejects imported history stamped in this week", () => {
    const window = { startAt: 996_400, resetAt: 1_000_000, resetWindowMins: 60 };
    expect(usageInLeaderboardCycle({ resetAt: 1_000_250, occurredAt: 997_000 }, "codex-account", window)).toBe(true);
    expect(usageInLeaderboardCycle({ resetAt: 999_699, occurredAt: 997_000 }, "codex-account", window)).toBe(false);
    expect(usageInLeaderboardCycle({ resetAt: 900_000, occurredAt: 997_000 }, "codex-account", window)).toBe(false);
    expect(usageInLeaderboardCycle({ resetAt: null, occurredAt: 997_000 }, "codex-account", window)).toBe(false);
  });

  it("recognizes a registered user's legacy home directory without guessing arbitrary folders", () => {
    const isKnown = (id: string) => id === "zyr";
    const workspaceRoot = "/home/ls/codex_zerotier_remote/users";
    expect(userIdFromSessionCwd("/home/ls/zyr/forgeloop", isKnown, workspaceRoot)).toBe("zyr");
    expect(userIdFromSessionCwd("/home/ls/unknown/project", isKnown, workspaceRoot)).toBeNull();
    expect(userIdFromSessionCwd("/home/ls/codex_zerotier_remote/users/gyj/project", isKnown, workspaceRoot)).toBe("gyj");
  });

  it("falls back to seven days when no GPT reset is available", () => {
    expect(apiLeaderboardCycleWindow([], 1_000_000)).toEqual({
      startAt: 395_200, resetAt: null, resetWindowMins: null
    });
  });

  it("adds API tokens without attributing them to GPT quota", () => {
    const scope = (userId: string, totalTokens: number, quotaPercent: number | null, quotaUsedPercent: number | null) => ({
      totalTokens,
      resetAt: 1_000_000,
      resetWindowMins: 60,
      startAt: 996_400,
      quotaUsedPercent,
      users: [{ userId, sharePercent: 100, quotaPercent, sessionCount: 1, models: [{ model: userId, effort: null, sessionCount: 1, ...tokens(totalTokens) }], ...tokens(totalTokens) }]
    });
    const gpt = { currentCycle: scope("gpt-user", 100, 40, 40), lifetime: scope("gpt-user", 100, null, null), updatedAt: "", errors: [] };
    const api = { currentCycle: scope("api-user", 200, null, null), lifetime: scope("api-user", 200, null, null), updatedAt: "", errors: [] };
    const source = (kind: "codex-account" | "api-provider", id: string) => ({ id, label: id, kind, sessionsRoot: "/tmp/unused", quota: {} as never });
    const merged = mergeAccountLeaderboards([gpt, api], [source("codex-account", "gpt"), source("api-provider", "api")]);
    expect(merged.currentCycle.totalTokens).toBe(300);
    expect(merged.currentCycle.quotaUsedPercent).toBe(40);
    expect(merged.currentCycle.users.find((user) => user.userId === "gpt-user")?.quotaPercent).toBe(40);
    expect(merged.currentCycle.users.find((user) => user.userId === "api-user")?.quotaPercent).toBeNull();
  });
});
