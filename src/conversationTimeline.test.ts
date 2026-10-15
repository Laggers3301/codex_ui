import { describe, expect, it } from "vitest";
import { coalesceToolOutputs, collapseCodeModeWrappers, latestUserTimelineIndex, liveTimelineItems, mergeTimelineItems } from "./conversationTimeline";
import type { ThreadItem } from "./types";

const time = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
const call = (n: number): ThreadItem => ({ id: `call-${n}`, callId: `call-${n}`, type: "toolCall", tool: n === 2 ? "view_image" : "exec", timelineAt: time(n) });
const message: ThreadItem = { id: "message", type: "agentMessage", text: "中间消息", timelineAt: time(19) };
const live = [...Array.from({ length: 18 }, (_, i) => call(i + 1)), message, call(20), call(21)];
function shape(items: ThreadItem[]): (number | string)[] {
  const result: (number | string)[] = [];
  for (const item of items) {
    if (item.type === "agentMessage") result.push(item.id);
    else if (typeof result.at(-1) === "number") result[result.length - 1] = Number(result.at(-1)) + 1;
    else result.push(1);
  }
  return result;
}

describe("one chronological conversation timeline", () => {
  it("locates the latest user boundary for the running status", () => {
    const items: ThreadItem[] = [
      { id: "old-answer", type: "agentMessage", role: "assistant" },
      { id: "latest-question", type: "userMessage", role: "user" },
      { id: "current-answer", type: "agentMessage", role: "assistant" }
    ];
    expect(latestUserTimelineIndex(items)).toBe(1);
    expect(latestUserTimelineIndex(items.slice(0, 1))).toBe(-1);
  });

  it("replaces a persisted code-mode wrapper with its durable concrete tools", () => {
    const wrapper: ThreadItem = { id: "call-wrapper", callId: "call-wrapper", sourceItemId: "ctc-wrapper", type: "toolCall", tool: "exec", input: "await tools.view_image(); await tools.exec_command()", timelineAt: time(1) };
    const output: ThreadItem = { id: "out-wrapper", callId: "call-wrapper", type: "toolCallOutput", aggregatedOutput: "done", timelineAt: time(5) };
    const children: ThreadItem[] = [
      { id: "exec-image", sourceItemId: "exec-image", type: "toolCall", tool: "view_image", timelineAt: time(2) },
      { id: "exec-command", sourceItemId: "exec-command", type: "toolCall", tool: "exec", timelineAt: time(3) }
    ];
    const projected = collapseCodeModeWrappers(coalesceToolOutputs([wrapper, ...children, output]));
    expect(projected.map((item) => item.id)).toEqual(["exec-image", "exec-command"]);
  });

  it("retains an outer wrapper when no durable concrete child exists", () => {
    const wrapper: ThreadItem = { id: "call-wrapper", type: "toolCall", tool: "exec", input: "await tools.exec_command()", timelineAt: time(1), completedAt: time(2) };
    expect(collapseCodeModeWrappers([wrapper])).toEqual([wrapper]);
  });

  it("hides a running wrapper as soon as its concrete child arrives", () => {
    const wrapper: ThreadItem = { id: "call-wrapper", type: "toolCall", tool: "exec", input: "await tools.apply_patch()", timelineAt: time(1) };
    const child: ThreadItem = { id: "exec-patch", sourceItemId: "exec-patch", type: "toolCall", tool: "apply_patch", timelineAt: time(2) };
    expect(collapseCodeModeWrappers([wrapper, child])).toEqual([child]);
  });
  it("matches raw item ids as well as call ids without duplicating a tool", () => {
    const result = mergeTimelineItems([{ ...call(1), id: "response-1" }], [{ id: "response-1", type: "toolCall", completed: true }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "call-1", completed: true });
  });

  it("joins legacy streamed segments without moving the message boundary", () => {
    const entries = liveTimelineItems([
      { id: "m::1", sourceItemId: "m", kind: "agent", text: "before ", sequence: 1, startedAt: time(1) },
      { id: "tool", kind: "tool", sequence: 2, startedAt: time(2) },
      { id: "m::3", sourceItemId: "m", kind: "agent", text: "after", sequence: 3, startedAt: time(3) }
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "m", text: "before after", timelineAt: time(1), timelineLive: true });
  });
  it("does not create tail bundles from the old server's uncorrelated outputs", () => {
    const old = live.flatMap((item): ThreadItem[] => item.type === "toolCall" ? [
      { id: `response-${item.id}`, type: "toolCall", tool: item.tool },
      { id: `${item.id}-output-old`, type: "toolCallOutput", text: item.id, aggregatedOutput: "done" }
    ] : [{ ...item, timelineAt: undefined }]);
    const projected = coalesceToolOutputs(mergeTimelineItems(coalesceToolOutputs(old), live));
    expect(shape(projected)).toEqual([18, "message", 2]);
    expect(projected).toHaveLength(21);
  });

  it("keeps genuinely orphaned output in place, including between messages", () => {
    const orphan: ThreadItem = { id: "orphan", type: "toolCallOutput", text: "unknown", aggregatedOutput: "out" };
    expect(coalesceToolOutputs([orphan, message, call(20)]).map((item) => item.id)).toEqual(["orphan", "message", "call-20"]);
  });

  it("uses shared message anchors when no history timestamps are available", () => {
    const history = [call(1), message, call(21)].map((item) => ({ ...item, timelineAt: undefined }));
    const updates = [call(2), message, call(20)];
    const projected = mergeTimelineItems(history, updates);
    expect(projected.findIndex((item) => item.id === "call-2")).toBeLessThan(projected.findIndex((item) => item.id === "message"));
    expect(shape(projected)).toEqual([2, "message", 2]);
  });
  it("keeps A18 / message / B2 as history catches up in arbitrary batches", () => {
    for (const count of [0, 5, 18, 19, 21]) {
      const history = live.slice(0, count).map((item) => item.type === "toolCall" ? { ...item, id: `response-${item.id}` } : item);
      const projected = coalesceToolOutputs(mergeTimelineItems(live, history));
      expect(shape(projected)).toEqual([18, "message", 2]);
      expect(projected.map((item) => item.id)).toEqual(live.map((item) => item.id));
    }
    expect(shape(mergeTimelineItems([], live))).toEqual([18, "message", 2]);
  });

  it("pairs parallel outputs by correlation, not their adjacent call", () => {
    const projected = coalesceToolOutputs(mergeTimelineItems([], [
      call(1), call(2),
      { id: "out-2", type: "toolCallOutput", callId: "call-2", aggregatedOutput: "second" },
      message,
      { id: "out-1", type: "toolCallOutput", callId: "call-1", aggregatedOutput: "first" }
    ]));
    expect(projected.map((item) => item.id)).toEqual(["call-1", "call-2", "message"]);
    expect(projected[0].aggregatedOutput).toBe("first");
    expect(projected[1].aggregatedOutput).toBe("second");
  });

  it("inserts missing page items at their original position without changing identities", () => {
    const merged = mergeTimelineItems([call(1), message, call(21)], [call(2), call(20)]);
    expect(merged.map((item) => item.id)).toEqual(["call-1", "call-2", "message", "call-20", "call-21"]);
    expect(mergeTimelineItems(merged, merged)).toEqual(merged);
  });
});
