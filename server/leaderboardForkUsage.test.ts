import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

it("counts new work, not token telemetry copied into a fork with new timestamps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "leaderboard-fork-"));
  vi.stubEnv("CODEX_WEB_CODEX_SESSION_ROOTS", root);
  vi.stubEnv("CODEX_THREAD_INDEX_DB", path.join(root, "index.sqlite"));
  vi.resetModules();
  try {
    const turn = (id: string, total: number) => [
      { type: "event_msg", payload: { type: "task_started", turn_id: id } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total, input_tokens: total } }, rate_limits: { primary: { resets_at: 1791046961 } } } }
    ];
    const rows = (records: unknown[]) => records.map(r => JSON.stringify({ timestamp: "2026-09-28T08:00:00Z", ...r as object })).join("\n") + "\n";
    const parentId = "00000000-0000-0000-0000-000000000001";
    const forkId = "00000000-0000-0000-0000-000000000002";
    await fs.writeFile(path.join(root, `rollout-${parentId}.jsonl`), rows([{ type: "session_meta", payload: { id: parentId } }, ...turn("inherited", 100)]));
    const fork = path.join(root, `rollout-${forkId}.jsonl`);
    await fs.writeFile(fork, rows([{ type: "session_meta", payload: { id: forkId, forked_from_id: parentId } }, ...turn("inherited", 100), ...turn("new", 25)]));
    const { summarizeLeaderboardFile } = await import("./routes.js");
    const summary = await summarizeLeaderboardFile(fork, { getUser: () => ({}) } as never, () => "quotaUser");
    expect(summary.usage.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(25);
    expect(summary.billingVersion).toBe(2);
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
