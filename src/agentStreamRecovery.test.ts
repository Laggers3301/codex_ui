import { expect, it } from "vitest";
import { recoverAgentStreams } from "./agentStreamRecovery";
import { coalesceToolOutputs, liveTimelineItems, mergeTimelineItems } from "./conversationTimeline";
import { applyLiveAgentUpdate, type AgentTextState } from "./liveAgentUpdates";

const base = (text: string, extra = {}): AgentTextState => ({ text, threadId: "t", turnId: "r", startedAt: new Date().toISOString(), ...extra });
it("marks only interrupted attempts and waits for a native complete message before retiring them", () => {
  const entries = new Map([["draft", base("half")], ["committed", base("prior", { completed: true })], ["other", base("other", { threadId: "other" })]]);
  for (const [id, entry] of recoverAgentStreams(entries, { method: "error", params: { threadId: "t", turnId: "r", willRetry: true } })) entries.set(id, entry);
  expect(entries.get("draft")?.streamState).toBe("interrupted");
  expect(recoverAgentStreams(entries, { method: "item/completed", params: { threadId: "t", turnId: "r", item: { id: "tool", type: "commandExecution", text: "success" } } })).toEqual([]);
  const changes = recoverAgentStreams(entries, { method: "item/completed", params: { threadId: "t", turnId: "r", item: { id: "replacement", type: "agentMessage", text: "完整答复。" } } });
  expect(changes).toEqual([["draft", expect.objectContaining({ streamState: "superseded", text: "half" })]]);
});
it("preserves authoritative stream lifecycle metadata over the wire", () => {
  expect(applyLiveAgentUpdate(undefined, { ...base("full"), completed: true, streamState: "completed" })).toMatchObject({ text: "full", completed: true, streamState: "completed" });
});
it("the visible transcript omits superseded drafts, not tools or other completed messages", () => {
  const items = liveTimelineItems([
    { id: "old", kind: "agent", ...base("half"), sequence: 1, streamState: "superseded" },
    { id: "new", kind: "agent", ...base("完整回复。"), sequence: 2, streamState: "completed", completed: true },
  ]);
  expect(coalesceToolOutputs(items).map(x => x.text)).toEqual(["完整回复。"]);
});
it("a shorter completed snapshot overrides stale draft text and cannot be resurrected by a later delta", () => {
  const old = { id: "m", type: "agentMessage", text: "完整回复后面是旧残留" };
  const done = { id: "m", type: "agentMessage", text: "完整回复", streamState: "completed", completed: true };
  const completed = mergeTimelineItems([old], [done]);
  expect(completed[0].text).toBe("完整回复");
  expect(mergeTimelineItems(completed, [{ ...old, text: "晚到的旧包", streamState: "streaming" }])[0].text).toBe("完整回复");
});
it("a superseded draft remains hidden after merging stale history", () => {
  const orphan = { id: "old", type: "agentMessage", text: "half", streamState: "superseded" };
  expect(coalesceToolOutputs(mergeTimelineItems([orphan], [{ ...orphan, streamState: "streaming" }]))).toEqual([]);
  // Preserve tombstones until after history/live merging, including an old
  // backend reconnect snapshot that has no recovery metadata yet.
  expect(coalesceToolOutputs(mergeTimelineItems(coalesceToolOutputs([orphan], true), [{ ...orphan, streamState: "streaming" }]))).toEqual([]);
});
it("late packets cannot resurrect superseded drafts or overwrite completed replies", () => {
  const retired = base("half", { streamState: "superseded" });
  expect(applyLiveAgentUpdate(retired, { ...base("stale") })).toBe(retired);
  const completed = base("完整答复", { streamState: "completed", completed: true });
  expect(applyLiveAgentUpdate(completed, { ...base("stale") })).toBe(completed);
});
