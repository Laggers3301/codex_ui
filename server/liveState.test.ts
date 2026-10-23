import { describe, expect, it } from "vitest";
import { LiveStateStore } from "./liveState.js";

describe("LiveStateStore reconnect bounds", () => {
  it("preserves typed async agent questions as tools for reconnect and answer delivery", () => {
    const state = new LiveStateStore();
    state.recordNotification({ method: "turn/started", params: { threadId: "thread", turnId: "turn" } });
    const item = { type: "agentMessage", id: "question", delivery: "async", text: "请选择", questions: [{ title: "请选择", options: ["A", "B"] }] };
    const update = state.recordNotification({ method: "item/started", params: { threadId: "thread", turnId: "turn", item } });
    expect(update?.kind).toBe("tool");
    expect(state.snapshot().agentMessages).toEqual([]);
    expect(state.snapshot().toolItems[0]).toMatchObject({ itemId: "question", tool: "request_user_input_async" });
    expect(JSON.parse(state.snapshot().toolItems[0].input)).toEqual({ questions: item.questions });
    expect(state.recordNotification({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "question", delta: "请选择" } })).toBeNull();
    state.recordNotification({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item } });
    expect(state.snapshot().agentMessages).toEqual([]);
    expect(state.snapshot().toolItems[0].completed).toBe(true);
  });

  it("does not split or reorder a message when a tool completes between deltas", () => {
    const state = new LiveStateStore();
    state.recordNotification({ method: "turn/started", params: { threadId: "thread", turnId: "turn" } });
    const delta = (text: string) => state.recordNotification({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", itemId: "message", delta: text } });
    const first = delta("before ");
    state.recordNotification({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "tool", type: "imageView" } } });
    const last = delta("after");
    expect(last?.item.itemId).toBe(first?.item.itemId);
    expect(last?.item.sequence).toBe(first?.item.sequence);
    expect(state.snapshot().agentMessages).toHaveLength(1);
    expect(state.snapshot().agentMessages[0].text).toBe("before after");
  });
  it("bounds live replay while preserving the newest active-turn previews", () => {
    const state = new LiveStateStore();
    const threadId = "thread-long";
    const turnId = "turn-long";

    state.recordNotification({
      method: "turn/started",
      params: { thread: { id: threadId }, turn: { id: turnId } }
    });

    for (let index = 0; index < 70; index += 1) {
      state.recordNotification({
        method: "item/commandExecution/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: `tool-${index}`,
            type: "commandExecution",
            command: `command-${index}-${"x".repeat(10_000)}`,
            output: `output-${index}-${"y".repeat(10_000)}`
          }
        }
      });
    }

    for (let index = 0; index < 45; index += 1) {
      state.recordNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          itemId: `message-${index}`,
          delta: `message-${index}`
        }
      });
    }

    const snapshot = state.snapshot();
    expect(snapshot.activeTurns).toHaveLength(1);
    expect(snapshot.toolItems).toHaveLength(48);
    expect(snapshot.agentMessages).toHaveLength(32);
    expect(snapshot.toolItems.at(-1)?.itemId).toBe("tool-69");
    expect(snapshot.agentMessages.at(-1)?.sourceItemId).toBe("message-44");
    expect(snapshot.toolItems.every((item) => item.input.length <= 6_000 && item.output.length <= 6_000)).toBe(true);
    expect(JSON.stringify(snapshot).length).toBeLessThan(650_000);

    state.recordNotification({
      method: "turn/completed",
      params: { thread: { id: threadId }, turn: { id: turnId } }
    });
    expect(state.snapshot()).toMatchObject({ agentMessages: [], toolItems: [], activeTurns: [] });

    state.recordNotification({
      method: "item/commandExecution/completed",
      params: {
        threadId,
        turnId,
        item: { id: "late-tool", type: "commandExecution", command: "late", output: "late" }
      }
    });
    expect(state.snapshot()).toMatchObject({ agentMessages: [], toolItems: [], activeTurns: [] });
  });
});
