import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { summarizeLeaderboardFile } from "./routes.js";

it("counts cumulative and final usage once through the actual leaderboard parser", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-usage-integration-"));
  try {
    const a = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } };
    const b = { input_tokens: 150, output_tokens: 30, input_tokens_details: { cached_tokens: 90 }, output_tokens_details: { reasoning_tokens: 9 } };
    const c = { input_tokens: 170, output_tokens: 40, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 11 } };
    const infos = [{ total_token_usage: a }, { total_token_usage: a }, { total_token_usage: b },
      { last_token_usage: { prompt_tokens: 20, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 2 } }, total_token_usage: c },
      { total_token_usage: c }];
    const rows = [{ type: "session_meta", payload: { id: "fixture" } }, { type: "turn_context", payload: { model: "fixture-model", turn_id: "r" } },
      ...infos.map(info => ({ type: "event_msg", payload: { type: "token_count", info } }))];
    const file = path.join(root, "rollout-fixture.jsonl");
    await fs.writeFile(file, rows.map(row => JSON.stringify({ timestamp: "2026-10-20T08:00:00Z", ...row })).join("\n"));
    const summary = await summarizeLeaderboardFile(file, { getUser: () => ({}) } as never, () => "fixture-user", true);
    const sums = summary.usage.reduce((a, u) => ({ input: a.input + u.inputTokens, output: a.output + u.outputTokens,
      cache: a.cache + u.cachedInputTokens, reasoning: a.reasoning + u.reasoningOutputTokens, total: a.total + u.totalTokens }), { input: 0, output: 0, cache: 0, reasoning: 0, total: 0 });
    expect(sums).toEqual({ input: 170, output: 40, cache: 100, reasoning: 11, total: 210 });
    expect(summary.providerUsageVersion).toBe(1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
