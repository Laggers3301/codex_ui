import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { activityWindow, groupSubagentDirectory, mergeDirectoryRows } from "./subagentOrganization";
import { SubagentActivity } from "./SubagentActivity";
import { reconcileSubagents, type AgentEntry } from "./subagentPresentation";
import type { SubagentThreadSummary } from "./types";

const agent = (id: string, state: AgentEntry["state"]): AgentEntry => ({ id, name: `/root/${id}`, state });
describe("subagent activity and retained history", () => {
  it("does not promote old completed agents into the current batch", () => {
    const window = activityWindow([agent("old", "completed"), agent("new", "running")], new Map(), true);
    expect(window.rows.map(row => row.id)).toEqual(["new"]);
  });
  it("temporarily retains the observed batch, then folds it after the parent finishes", () => {
    const observed = new Map<string, AgentEntry>();
    activityWindow([agent("worker", "running")], observed, true);
    expect(activityWindow([agent("worker", "completed")], observed, true).recent.map(row => row.id)).toEqual(["worker"]);
    expect(activityWindow([agent("worker", "completed")], observed, false).rows).toEqual([]);
  });
  it("keeps a child active after the parent reply ends, and reactivates an old child on followup", () => {
    const observed = new Map([["worker", agent("worker", "completed")]]);
    expect(activityWindow([agent("worker", "running")], observed, false).active).toHaveLength(1);
    expect(activityWindow([agent("worker", "running")], observed, true).recent).toEqual([]);
  });
  it("bounds recent completed rows without deleting their metadata", () => {
    const observed = new Map<string, AgentEntry>();
    const agents = Array.from({ length: 120 }, (_, i) => agent(`worker-${i}`, "running"));
    activityWindow(agents, observed, true);
    const result = activityWindow(agents.map(row => ({ ...row, state: "completed" })), observed, true);
    expect(result.recent).toHaveLength(120);
    expect(result.rows).toHaveLength(3);
    expect(observed.size).toBe(120);
  });
  it("renders only a small persistent history entry when idle, including global totals beyond the page", () => {
    const html = renderToStaticMarkup(<SubagentActivity agents={[agent("old", "completed")]} onOpenHistory={() => {}} directoryPage={{ total: 180, activeCount: 0, historyCount: 180, unknownCount: 0, hasMore: true, nextCursor: "next" }} />);
    expect(html).toContain("子代理记录 · 180");
    expect(html).not.toContain("subagentRow\"");
    expect(html).not.toContain("/root/old");
    expect(html).not.toContain("本轮 0");
  });
  it("uses authoritative native IDs when a legacy named dispatch reconciles with the directory", () => {
    const [row] = reconcileSubagents([agent("worker", "dispatched")], [{ id: "native-id", name: "/root/worker", parentThreadId: "parent", state: "completed", createdAt: "2026-10-02T00:00:00Z" }]);
    expect(row).toMatchObject({ id: "native-id", state: "completed", createdAt: "2026-10-02T00:00:00Z" });
  });
});
describe("directory pagination and grouping", () => {
  const row = (id: string, lastTaskAt?: string): SubagentThreadSummary => ({ id, name: id, parentThreadId: "parent", state: "completed", lastTaskAt });
  it("merges overlapping pages by stable ID, preserving order and updated metadata", () => {
    expect(mergeDirectoryRows([row("a"), row("b")], [{ ...row("b"), state: "running" }, row("c")]).map(({ id, state }) => [id, state]))
      .toEqual([["a", "completed"], ["b", "running"], ["c", "completed"]]);
  });
  it("groups by real task date and keeps missing dates separate, without guessing task content", () => {
    const groups = groupSubagentDirectory([row("a", "2026-10-02T08:00:00Z"), row("b", "2026-10-02T09:00:00Z"), row("c", "2026-10-01T08:00:00Z"), row("unknown")]);
    expect(groups.map(group => group.agents.map(agent => agent.id))).toEqual([["a", "b"], ["c"], ["unknown"]]);
    expect(groups.at(-1)?.date).toBeNull();
  });
});
