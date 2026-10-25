import { expect, it } from "vitest";
import { LiveStateStore } from "./liveState.js";
import { journalItem, overlayJournal } from "./timelineJournal.js";

function fixture() {
  const state = new LiveStateStore();
  const send = (method: string, extra: Record<string, unknown> = {}) => state.recordNotification({ method, params: { threadId: "thread", turnId: "turn", ...extra } });
  send("turn/started");
  return { state, send };
}
it("streams summaries immediately, preserves start order across tools/body, and completes without duplication", () => {
  const { state, send } = fixture();
  const started = send("item/started", { item: { id: "reason", type: "reasoning", summary: [], encrypted_content: "NEVER EXPOSE" } })!;
  expect(started.kind).toBe("reasoning");
  expect(started.item).toMatchObject({ text: "", completed: false });
  const first = send("item/reasoning/summaryTextDelta", { itemId: "reason", summaryIndex: 0, delta: "第一段" })!;
  expect(first.item).toMatchObject({ text: "第一段", sequence: started.item.sequence, startedAt: started.item.startedAt });
  const tool = send("item/started", { item: { id: "tool", type: "commandExecution", command: "fixture" } })!;
  const body = send("item/agentMessage/delta", { itemId: "answer", delta: "正文" })!;
  send("item/reasoning/summaryPartAdded", { itemId: "reason", summaryIndex: 1 });
  send("item/reasoning/summaryTextDelta", { itemId: "reason", summaryIndex: 1, delta: "第二段" });
  const completed = send("item/completed", { item: { id: "reason", type: "reasoning", summary: [{ type: "summary_text", text: "第一段" }, { type: "summary_text", text: "第二段" }] } })!;
  expect(completed.item).toMatchObject({ text: "第一段\n\n第二段", completed: true, sequence: first.item.sequence });
  expect(first.item.sequence).toBeLessThan(tool.item.sequence);
  expect(tool.item.sequence).toBeLessThan(body.item.sequence);
  expect(state.snapshot().reasoningMessages).toHaveLength(1);
  expect(JSON.stringify(state.snapshot())).not.toContain("NEVER EXPOSE");
  expect(send("item/reasoning/summaryTextDelta", { itemId: "reason", delta: "late" })).toBeNull();
  expect(journalItem(completed)).toMatchObject({ id: "reason", type: "reasoning", summary: ["第一段\n\n第二段"] });
  send("turn/completed");
  expect(state.snapshot().reasoningMessages).toEqual([]);
});
it("handles missing start, empty completion, malformed indices and old-turn events without losing text", () => {
  const { state, send } = fixture();
  expect(send("item/reasoning/summaryTextDelta", { itemId: "bad", summaryIndex: -1, delta: "bad" })).toBeNull();
  expect(send("item/reasoning/summaryTextDelta", { itemId: "old", turnId: "old", delta: "bad" })).toBeNull();
  expect(send("item/reasoning/textDelta", { itemId: "raw", delta: "not a public summary" })).toBeNull();
  send("item/reasoning/summaryTextDelta", { itemId: "reason", delta: "收到的摘要" });
  send("item/completed", { item: { id: "reason", type: "reasoning", summary: [] } });
  expect(state.snapshot().reasoningMessages?.[0]).toMatchObject({ text: "收到的摘要", completed: true });
  state.clear();
  expect(state.snapshot().reasoningMessages).toEqual([]);
});
it("bounds replay text and item count", () => {
  const { state, send } = fixture();
  for (let n = 0; n < 40; n++) send("item/reasoning/summaryTextDelta", { itemId: `r${n}`, delta: "a".repeat(100_000) });
  expect(state.snapshot().reasoningMessages).toHaveLength(32);
  expect(state.snapshot().reasoningMessages!.every(item => item.text.length <= 64_000)).toBe(true);
});
it("overlays a partial native snapshot by ID with one complete summary and its first position", () => {
  const { send } = fixture();
  const update = send("item/completed", { item: { id: "reason", type: "reasoning", summary: ["完整摘要"] } })!;
  const entry = journalItem(update);
  const result = overlayJournal({ turns: [{ id: "turn", items: [{ id: "reason", type: "reasoning", summary: [] }] }] }, () => [entry], true) as any;
  expect(result.turns[0].items).toHaveLength(1);
  expect(result.turns[0].items[0]).toMatchObject({ summary: ["完整摘要"], timelineAt: entry.timelineAt });
});
