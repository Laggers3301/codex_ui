import { describe, expect, it, vi } from "vitest";
import { groupSubagentRecordItems, mergeSubagentHistory } from "./subagentHistory";
import { subagentAvatarIdentity } from "./SubagentAvatar";
import { sameSubagentDirectory } from "./subagentDirectory";
import type { ThreadItem, ThreadSummary, Turn } from "./types";

vi.mock("./api", () => ({ listSubagentThreads: vi.fn() }));

const turn = (id: string, itemIds: string[], status = "completed"): Turn => ({ id, status, startedAt: null, completedAt: null, items: itemIds.map(id => ({ id, type: "agentMessage", text: id })) });
const thread = (turns: Turn[]): ThreadSummary => ({ id: "child", sessionId: "child", preview: "", name: "worker", cwd: "/test", createdAt: 1, updatedAt: 2, status: "idle", turns });

describe("subagent history", () => {
  it("prepends older turns without duplicating an overlapping page", () => {
    const older = thread([turn("a", ["a1"]), turn("b", ["b1", "b2"])]);
    const latest = thread([turn("b", ["b2", "b3"]), turn("c", ["c1"])]);
    const merged = mergeSubagentHistory(older, latest);
    expect(merged.turns.map(turn => turn.id)).toEqual(["a", "b", "c"]);
    expect(merged.turns[1].items.map(item => item.id)).toEqual(["b1", "b2", "b3"]);
  });
  it("keeps loaded history when polling adds a result to the current turn", () => {
    const loaded = thread([turn("a", ["a1"]), turn("b", ["b1"], "running")]);
    const latest = thread([turn("b", ["b1", "b2"])]);
    const merged = mergeSubagentHistory(loaded, latest);
    expect(merged.turns.map(turn => turn.id)).toEqual(["a", "b"]);
    expect(merged.turns[1].status).toBe("completed");
    expect(mergeSubagentHistory(merged, latest)).toEqual(merged);
  });
  it("uses the same avatar identity in task events and child records", () => {
    expect(subagentAvatarIdentity("/root/worker")).toEqual(subagentAvatarIdentity("worker"));
    expect(subagentAvatarIdentity("/root/document_editor")).not.toEqual(subagentAvatarIdentity("/root/document_backend"));
  });
  it("does not repaint unchanged directory polls, but keeps completion/model changes", () => {
    const rows = [{ id: "worker", name: "/root/worker", parentThreadId: "parent", model: "gpt-6-luna", state: "running", updatedAt: 2 }];
    expect(sameSubagentDirectory(rows, rows.map(row => ({ ...row })))).toBe(true);
    expect(sameSubagentDirectory(rows, [{ ...rows[0], state: "completed" }])).toBe(false);
    expect(sameSubagentDirectory(rows, [{ ...rows[0], model: "gpt-6-sol" }])).toBe(false);
    expect(sameSubagentDirectory(rows, [])).toBe(false);
  });
});

describe("subagent activity bundles", () => {
  const tool = (id: string): ThreadItem => ({ id, type: "toolCall", tool: "exec", input: "pwd" });
  const thought = (id: string): ThreadItem => ({ id, type: "reasoning", text: "检查文件" });
  const body = (id: string): ThreadItem => ({ id, type: "agentMessage", text: "结果" });
  it("groups consecutive calls/thoughts but never swallows prose or the next activity block", () => {
    const rows = groupSubagentRecordItems("turn", [body("start"), thought("r1"), tool("t1"), tool("t2"), body("answer"), tool("t3")]);
    expect(rows.map(row => [row.bundle, row.items.map(item => item.id)])).toEqual([
      [false, ["start"]], [true, ["r1", "t1", "t2"]], [false, ["answer"]], [true, ["t3"]]
    ]);
  });
  it("retains open bundle identity across live append, completion and same-turn history prepend", () => {
    const first = groupSubagentRecordItems("turn", [thought("r1"), tool("t1")]);
    const live = groupSubagentRecordItems("turn", [thought("r1"), tool("t1"), tool("t2")], first);
    const complete = groupSubagentRecordItems("turn", [thought("r1"), tool("t1"), tool("t2"), body("answer")], live);
    const older = groupSubagentRecordItems("turn", [tool("older"), thought("r1"), tool("t1"), tool("t2"), body("answer")], complete);
    expect([live[0].key, complete[0].key, older[0].key]).toEqual([first[0].key, first[0].key, first[0].key]);
  });
  it("does not bundle thinking-only summaries or standalone delegation cards", () => {
    const dispatch: ThreadItem = { id: "child", type: "toolCall", tool: "spawn_agent", input: { task_name: "worker" } };
    const rows = groupSubagentRecordItems("turn", [thought("r1"), thought("r2"), dispatch, tool("t1")]);
    expect(rows.map(row => row.bundle)).toEqual([false, false, false, true]);
    expect(rows[2].items[0]).toBe(dispatch);
  });
  it("keeps file changes in activity and unpaired outputs visible outside the bundle", () => {
    const rows = groupSubagentRecordItems("turn", [tool("t1"), { id: "file", type: "fileChange", changes: [] }, { id: "output", type: "toolResult", output: "unpaired" }, body("answer")]);
    expect(rows.map(row => row.items.map(item => item.id))).toEqual([["t1", "file"], ["output"], ["answer"]]);
  });
  it("never creates duplicate keys when a late body splits a previous bundle", () => {
    const previous = groupSubagentRecordItems("turn", [tool("t1"), tool("t2")]);
    const rows = groupSubagentRecordItems("turn", [tool("t1"), body("late"), tool("t2")], previous);
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
  });
});
