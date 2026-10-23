import { describe, expect, it } from "vitest";
import { LiveStateStore } from "./liveState.js";
import { journalItem, overlayJournal } from "./timelineJournal.js";
import { AppError } from "./appErrors.js";

describe("interrupted agent sampling attempts", () => {
  const fixture = () => {
    const state = new LiveStateStore();
    const rows = new Map<string, Record<string, unknown>>();
    const send = (method: string, params: Record<string, unknown>) => {
      const update = state.recordNotification({ method, params });
      if (update) rows.set(update.item.itemId, journalItem(update));
      for (const item of state.recordAgentRecovery({ method, params })) rows.set(item.itemId, journalItem({ kind: "agent", item }));
      return update;
    };
    send("turn/started", { threadId: "t", turnId: "r" });
    const delta = (id: string, text: string) => send("item/agentMessage/delta", { threadId: "t", turnId: "r", itemId: id, delta: text });
    const finish = (id: string, text: string) => send("item/completed", { threadId: "t", turnId: "r", item: { id, type: "agentMessage", text } });
    const disconnect = () => send("error", { threadId: "t", turnId: "r", willRetry: true, error: { message: "stream disconnected before completion" } });
    return { state, rows, send, delta, finish, disconnect };
  };
  it("replays the screenshot case and retains bytes but retires only the abandoned half-sentence", () => {
    const f = fixture(); f.delta("before", "已确认的进度。"); f.finish("before", "已确认的进度。");
    f.delta("abandoned", "所以，这次不是……而是当前模型还没有完整"); f.disconnect();
    expect(f.rows.get("abandoned")).toMatchObject({ completed: false, streamState: "interrupted" });
    f.delta("replacement", "因此，这次应优先修的是完整碰撞场景登记。");
    expect(f.rows.get("abandoned")?.streamState).toBe("interrupted");
    f.finish("replacement", "因此，这次应优先修的是完整碰撞场景登记。");
    expect(f.rows.get("abandoned")).toMatchObject({ text: "所以，这次不是……而是当前模型还没有完整", streamState: "superseded", completed: false });
    expect(f.rows.get("before")?.streamState).toBe("completed");
    expect(f.rows.get("replacement")?.streamState).toBe("completed");
    expect(f.delta("abandoned", "late packet")).toBeNull();
  });
  it("does not hide incomplete text after failed recovery or tool completion", () => {
    const f = fixture(); f.delta("draft", "not finished"); f.disconnect();
    f.send("item/completed", { threadId: "t", turnId: "r", item: { type: "commandExecution", id: "tool", command: "fixture", output: "done" } });
    expect(f.rows.get("draft")?.streamState).toBe("interrupted");
    f.send("turn/completed", { threadId: "t", turn: { id: "r", status: "failed" } });
    expect(f.rows.get("draft")?.streamState).toBe("interrupted");
  });
  it("accepts recovery with the same item ID and an authoritative shorter final text", () => {
    const f = fixture(); f.delta("draft", "完整回复后面是不应保留的尝试片段"); f.disconnect();
    f.finish("draft", "完整回复");
    expect(f.rows.get("draft")).toMatchObject({ text: "完整回复", completed: true, streamState: "completed" });
  });
  it("never affects another thread or a completed earlier message", () => {
    const f = fixture(); f.delta("done", "done"); f.finish("done", "done"); f.delta("draft", "partial");
    f.send("turn/started", { threadId: "other", turnId: "other-turn" });
    f.send("error", { threadId: "other", turnId: "other-turn", willRetry: true });
    expect(f.rows.get("draft")?.streamState).toBe("streaming"); f.disconnect();
    f.send("item/completed", { threadId: "other", turnId: "other-turn", item: { type: "agentMessage", id: "other-answer", text: "answer" } });
    expect(f.rows.get("draft")?.streamState).toBe("interrupted"); expect(f.rows.get("done")?.streamState).toBe("completed");
  });
  it("reconciles legacy journal orphans only inside the loaded native history interval", () => {
    const at = (n: number) => new Date(1700000000000 + n * 1000).toISOString();
    const entries = [
      { id: "partial", type: "agentMessage", text: "half sentence", timelineAt: at(2) },
      { id: "confirmed", type: "agentMessage", text: "confirmed", completed: true, timelineAt: at(2) },
      { id: "tail", type: "agentMessage", text: "still streaming", timelineAt: at(4) },
      { id: "tool", type: "toolCall", timelineAt: at(2) }
    ];
    const result = overlayJournal({ turns: [{ id: "r", items: [
      { id: "first", type: "agentMessage", timelineAt: at(1) },
      { id: "last", type: "agentMessage", text: "native answer", timelineAt: at(3) }
    ] }] }, () => entries, true);
    const items = (result.turns as {items: Record<string, unknown>[]}[])[0].items;
    expect(items.find(x => x.id === "partial")).toMatchObject({ text: "half sentence", streamState: "superseded" });
    expect(items.filter(x => x.streamState === "superseded")).toHaveLength(1);
    expect(items.find(x => x.id === "last")).toMatchObject({ streamState: "completed", completed: true, text: "native answer" });
    const failed = overlayJournal({ turns: [{ id: "r", items: [] }] }, () => entries.slice(0, 1), true);
    expect((failed.turns as {items: Record<string, unknown>[]}[])[0].items[0].streamState).not.toBe("superseded");
  });
  it("keeps transport failures retryable without retrying auth or quota failures", () => {
    expect(AppError.from({ message: "stream disconnected before completion: peer closed connection" })).toMatchObject({ code: "stream_disconnected", retryable: true });
    expect(AppError.from({ message: "401 invalid token" }).retryable).toBe(false);
    expect(AppError.from({ message: "usage_limit" }).retryable).toBe(false);
  });
});
