import { describe, expect, it } from "vitest";
import { normalizeProviderNotification, ProviderTurnProtocol } from "./providerProtocol.js";
import { LiveStateStore } from "./liveState.js";
import { CodexBridge } from "./codexBridge.js";

const start = (threadId = "t", id = "r") => ({ method: "turn/started", params: { threadId, turn: { id } } });
describe("provider native event contract", () => {
  it("ignores malformed native envelopes without crashing or exposing their payload", () => {
    const bridge = new CodexBridge();
    const stderr: string[] = []; const events: unknown[] = [];
    bridge.on("stderr", line => stderr.push(line)); bridge.on("notification", event => events.push(event));
    const input = bridge as unknown as { handleLine: (line: string) => void };
    for (const value of [null, [], 42, { method: 2, params: "private" }, { id: {}, result: "private" }, { params: "private" }]) expect(() => input.handleLine(JSON.stringify(value))).not.toThrow();
    expect(events).toHaveLength(0);
    expect(stderr).toHaveLength(6);
    expect(stderr.join("")).not.toContain("private");
  });
  it("normalizes explicit names and IDs without touching text, thought or fragmented arguments", () => {
    const event = normalizeProviderNotification({ method: "item/agent_message/delta", params: { thread_id: "t", turn_id: "r", item_id: "m", delta: "中文 🙂 <tool>not executable</tool>" } });
    expect(event).toMatchObject({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "r", itemId: "m", delta: "中文 🙂 <tool>not executable</tool>" } });
    for (const event of [
      { method: "item/reasoning/textDelta", params: { threadId: "t", delta: "private reasoning" } },
      { method: "item/functionCall/argumentsDelta", params: { delta: '{"cmd":"' } },
      { method: "item/functionCall/argumentsDelta", params: { delta: 'pwd"}' } }
    ]) expect(normalizeProviderNotification(event)).toBe(event);
  });
  it("only closes explicit non-retrying fatal errors, once, scoped to the right turn", () => {
    const state = new ProviderTurnProtocol();
    state.accept(start()); state.accept(start("other", "r2"));
    expect(state.accept({ method: "error", params: { threadId: "t", turnId: "r", willRetry: true, error: { message: "temporary" } } })).toHaveLength(1);
    expect(state.accept({ method: "error", params: { threadId: "t", turnId: "r", error: { message: "unknown" } } })).toHaveLength(1);
    const failure = state.accept({ method: "error", params: { threadId: "t", turnId: "r", willRetry: false, error: { code: "overloaded", message: "capacity" } } });
    expect(failure).toHaveLength(2);
    expect(failure[1]).toMatchObject({ method: "turn/completed", params: { threadId: "t", turn: { id: "r", status: "failed", error: { message: "capacity" } } } });
    expect(state.accept({ method: "turn/completed", params: { threadId: "t", turn: { id: "r", status: "failed" } } })).toEqual([]);
    expect(state.accept({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "r", delta: "late" } })).toEqual([]);
    expect(state.accept({ method: "turn/completed", params: { threadId: "other", turn: { id: "r2", status: "completed" } } })).toHaveLength(1);
  });
  it("does not infer success from tool completion or finalize an unrelated turn", () => {
    const state = new ProviderTurnProtocol(); state.accept(start());
    expect(state.accept({ method: "item/completed", params: { threadId: "t", turnId: "r", item: { id: "c", type: "function_call", arguments: "{}" } } })).toMatchObject([{ params: { item: { type: "functionCall" } } }]);
    expect(state.accept({ method: "error", params: { threadId: "t", turnId: "old", willRetry: false } })).toHaveLength(1);
    expect(state.accept({ method: "error", params: { threadId: "t", willRetry: false } })).toHaveLength(2);
    expect(state.accept(start())).toEqual([]);
  });
  it("recovers final-only agent messages and replaces snapshots without duplicated text", () => {
    const state = new LiveStateStore(); state.recordNotification(start());
    state.recordNotification({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "r", itemId: "m", delta: "hello" } });
    const complete = state.recordNotification({ method: "item/completed", params: { threadId: "t", turnId: "r", item: { id: "m", type: "agentMessage", text: "hello world" } } });
    expect(complete).toMatchObject({ kind: "agent", item: { text: "hello world", completed: true, sequence: 1 } });
    expect(state.recordNotification({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "r", itemId: "m", delta: " late duplicate" } })).toBeNull();
    expect(state.snapshot().agentMessages[0].text).toBe("hello world");
    const finalOnly = state.recordNotification({ method: "item/completed", params: { threadId: "t", turnId: "r", item: { id: "m2", type: "agentMessage", content: [{ type: "output_text", text: "只返回最终正文" }] } } });
    expect(finalOnly).toMatchObject({ kind: "agent", item: { text: "只返回最终正文", completed: true } });
    expect(state.snapshot().toolItems).toHaveLength(0);
    state.recordNotification({ method: "turn/completed", params: { threadId: "t", turn: { id: "r", status: "completed" } } });
    expect(state.recordNotification({ method: "item/completed", params: { threadId: "t", turnId: "r", item: { id: "late", type: "agentMessage", text: "late" } } })).toBeNull();
  });
  it("isolates interleaved concurrent turns and never loses ordered Unicode deltas", () => {
    const protocol = new ProviderTurnProtocol();
    const textByThread = new Map<string, string>();
    for (let n = 0; n < 50; n++) protocol.accept(start(`t${n}`, `r${n}`));
    for (const delta of ["中文", "🙂", " English", "\n结束"]) for (let n = 0; n < 50; n++) {
      for (const event of protocol.accept({ method: "item/agentMessage/delta", params: { threadId: `t${n}`, turnId: `r${n}`, itemId: "shared-item-id", delta } })) {
        const p = event.params as { threadId: string; delta: string };
        textByThread.set(p.threadId, (textByThread.get(p.threadId) ?? "") + p.delta);
      }
    }
    expect(textByThread.size).toBe(50);
    expect([...textByThread.values()].every(text => text === "中文🙂 English\n结束")).toBe(true);
    for (let n = 0; n < 50; n++) expect(protocol.accept({ method: "turn/completed", params: { threadId: `t${n}`, turn: { id: `r${n}`, status: n % 2 ? "interrupted" : "completed" } } })).toHaveLength(1);
  });
});
