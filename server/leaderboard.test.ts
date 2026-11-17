import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { serverConfig } from "./config.js";
import { apiLeaderboardCycleWindow, applyAccruedTrackedQuota, estimateLifetimeTokenQuota, mergeAccountLeaderboards, presentLeaderboard, usageInLeaderboardCycle, userIdFromSessionCwd } from "./routes.js";
import { memberRealName } from "../shared/memberDirectory.js";

vi.mock('../shared/memberDirectory.js', () => { const names: Record<string, string> = { bob: '乙同学', dave: '丁同学', carol: '丙同学', erin: '戊同学', 'qa-user': '甲同学', heidi: '庚同学', grace: '己同学' }; return { memberDirectory: names, memberRealName: (id: string) => Object.hasOwn(names, id) ? names[id] : null }; });

const tokens = (totalTokens: number) => ({
  inputTokens: totalTokens,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens
});

describe("API-provider leaderboard usage", () => {
  it("uses roster names without guessing unmatched IDs or changing login IDs", () => {
    expect(memberRealName("bob")).toBe("乙同学");
    expect(memberRealName("dave")).toBe("丁同学");
    expect(memberRealName("carol")).toBe("丙同学");
    expect(memberRealName("erin")).toBe("戊同学");
    expect(memberRealName("jpy1")).toBeNull();
    expect(memberRealName("frank")).toBeNull();
  });

  it("normalizes people and per-model quota against the complete GPT pool, excluding independent API tokens", () => {
    const scope = (quota: number | null, models: Array<{ model: string; amount: number }>) => ({
      totalTokens: models.reduce((sum, model) => sum + model.amount, 0), resetAt: 1_000_000,
      resetWindowMins: 60, startAt: 996_400, quotaUsedPercent: quota,
      users: [{ userId: "bob", sharePercent: 100, quotaPercent: quota, sessionCount: 1,
        models: models.map(model => ({ model: model.model, effort: null, sessionCount: 1, ...tokens(model.amount) })),
        ...tokens(models.reduce((sum, model) => sum + model.amount, 0)) }]
    });
    const board = (quota: number | null, models: Array<{ model: string; amount: number }>) => ({
      currentCycle: scope(quota, models), lifetime: scope(null, models), updatedAt: "", errors: []
    });
    const boards = [board(40, [{ model: "gpt-6.1-sol", amount: 75 }, { model: "gpt-6-astra", amount: 25 }]),
      board(10, [{ model: "gpt-6.1-sol", amount: 100 }]), board(null, [{ model: "doubao", amount: 500 }])];
    const sources = ["codex-account", "codex-account", "api-provider"].map((kind, index) => ({
      id: String(index), label: String(index), kind, sessionsRoot: "/tmp/unused", quota: {}
    }));
    const result = presentLeaderboard(mergeAccountLeaderboards(boards, sources as never));
    const user = result.currentCycle.users[0];
    expect(result.quotaAccountCount).toBe(2);
    expect(user.displayName).toBe("乙同学");
    expect(user.userId).toBe("bob");
    expect(user.poolQuotaPercent).toBe(25);
    expect(user.models.find(model => model.model === "gpt-6.1-sol")?.poolQuotaPercent).toBe(20);
    expect(user.models.find(model => model.model === "gpt-6-astra")?.poolQuotaPercent).toBe(5);
    expect(user.models.find(model => model.model === "doubao")?.poolQuotaPercent).toBeNull();
    expect(result.lifetime.users[0].poolQuotaPercent).toBe(25);
  });

  it("converts history into equivalent quota without capping multiple cycles at 100%", () => {
    expect(estimateLifetimeTokenQuota(2000, 100, 20)).toBe(400);
    expect(estimateLifetimeTokenQuota(2000, 0, 20)).toBeNull();
    expect(estimateLifetimeTokenQuota(2000, 100, null)).toBeNull();
    expect(estimateLifetimeTokenQuota(2000, 100, 0)).toBeNull();
  });

  it("calibrates lifetime quota per GPT account, using the pool average only when an account has no current sample", () => {
    const scope = (amount: number, quota: number | null, model = "gpt-6.1-sol") => ({ totalTokens: amount,
      resetAt: null, resetWindowMins: null, startAt: null, quotaUsedPercent: quota,
      users: amount ? [{ userId: "bob", ...tokens(amount), sharePercent: 100, quotaPercent: quota, sessionCount: 1,
        models: [{ model, effort: null, sessionCount: 1, ...tokens(amount) }] }] : [] });
    const boards = [
      { currentCycle: scope(100, 20), lifetime: scope(2000, null), updatedAt: "", errors: [] },
      { currentCycle: scope(100, 40), lifetime: scope(3000, null), updatedAt: "", errors: [] },
      { currentCycle: scope(100000, null, "doubao"), lifetime: scope(1000000, null, "doubao"), updatedAt: "", errors: [] }
    ];
    const sources = ["codex-account", "codex-account", "api-provider"].map((kind, index) => ({ id: String(index), label: String(index), kind, sessionsRoot: "/tmp/unused", quota: {} }));
    const result = presentLeaderboard(mergeAccountLeaderboards(boards, sources as never));
    expect(result.lifetime.users[0].poolQuotaPercent).toBe(800);
    expect(result.lifetime.users[0].models.find(model => model.model === "gpt-6.1-sol")?.poolQuotaPercent).toBe(800);
    expect(result.lifetime.users[0].models.find(model => model.model === "doubao")?.poolQuotaPercent).toBeNull();
    boards[1].currentCycle = scope(0, null);
    const fallback = presentLeaderboard(mergeAccountLeaderboards(boards, sources as never));
    expect(fallback.lifetime.users[0].poolQuotaPercent).toBe(500);
    boards[0].currentCycle = scope(0, null);
    expect(presentLeaderboard(mergeAccountLeaderboards(boards, sources as never)).lifetime.users[0].poolQuotaPercent).toBeNull();
  });

  it("shows accrued tracked quota rather than diluting it with token share", () => {
    const board = { currentCycle: { users: [{ userId: "sample-user", quotaPercent: 29.7 }, { userId: "other", quotaPercent: 10 }] } } as never;
    const sources = [{ id: "0003", kind: "codex-account", quota: { rateLimits: { primary: { resetsAt: 1000000 } } } }] as never;
    const ledger = { "0003": { resetAt: 1000002, userCycleQuotaPercent: 78 } } as never;
    const result = applyAccruedTrackedQuota(board, sources, ledger, "sample-user");
    expect(result.currentCycle.users[0].quotaPercent).toBe(78);
    expect(result.currentCycle.users[1].quotaPercent).toBe(10);
  });
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
    const isKnown = (id: string) => id === "registered-user";
    const managed = path.resolve(process.env.CODEX_WEB_USER_WORKSPACE_ROOT ?? path.join(serverConfig.dataDir, "users"));
    const legacy = path.dirname(path.dirname(managed));
    expect(userIdFromSessionCwd(path.join(legacy,"registered-user/project"), isKnown)).toBe("registered-user");
    expect(userIdFromSessionCwd(path.join(legacy,"unknown/project"), isKnown)).toBeNull();
    expect(userIdFromSessionCwd(path.join(managed,"qa-user/project"), isKnown)).toBe("qa-user");
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
