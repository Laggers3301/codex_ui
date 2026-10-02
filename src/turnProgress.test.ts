import { describe, expect, it } from "vitest";
import { readTurnProgress, turnProgressText, updateTurnProgress } from "./turnProgress";

describe("scoped turn progress", () => {
  it("keeps notices within their user/thread and rejects an old turn", () => {
    const old = { threadId: "a", turnId: "old", state: "no_progress", silentForMs: 130_000 };
    const current = updateTurnProgress({}, "qaUser", old, "old");
    expect(current["qaUser:a"]).toEqual(old);
    expect(current["other:a"]).toBeUndefined();
    expect(updateTurnProgress(current, "qaUser", old, "new")).toBe(current);
    expect(updateTurnProgress(current, "qaUser", { ...old, turnId: "new", state: "active" })).toBe(current);
    expect(updateTurnProgress(current, "qaUser", { ...old, state: "active" })).toEqual({});
  });
  it("does not call an approval or collaboration wait a failed task", () => {
    expect(readTurnProgress({ threadId: "a" })).toBeNull();
    const progress = readTurnProgress({ threadId: "a", turnId: "t", state: "waiting_approval", silentForMs: 200_000 })!;
    expect(turnProgressText(progress)).toContain("等待操作批准");
    expect(turnProgressText({ ...progress, state: "waiting_subagents" })).toContain("子代理状态更新");
    expect(turnProgressText({ ...progress, state: "no_progress" })).toContain("核对运行状态");
  });
});
