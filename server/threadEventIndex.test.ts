import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

it("removes a rolled-back legacy turn from incremental and fresh history reads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-index-rollback-"));
  vi.stubEnv("CODEX_THREAD_INDEX_DB", path.join(root, "index.sqlite"));
  vi.stubEnv("CODEX_WEB_CODEX_SESSION_ROOTS", root);
  vi.resetModules();
  try {
    const file = path.join(root, "rollout-thread.jsonl");
    const turn = (id: string, text: string) => [
      { type: "event_msg", payload: { type: "task_started", turn_id: id } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: id } }
    ];
    const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
    await fs.writeFile(file, lines([{ type: "session_meta", payload: { id: "thread", history_mode: "legacy" } }, ...turn("first", "keep me"), ...turn("wrong", "remove me")]));
    const { readIndexedThreadPage } = await import("./threadEventIndex.js");
    const { readThreadFromJsonl } = await import("./threadFallback.js");
    expect(JSON.stringify(await readIndexedThreadPage(file, "thread", { limit: 120 }))).toContain("remove me");
    await fs.appendFile(file, lines([{ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }, ...turn("replacement", "corrected question")]));
    const page = await readIndexedThreadPage(file, "thread", { limit: 120 });
    expect(JSON.stringify(page)).not.toContain("remove me");
    expect(JSON.stringify(page)).toContain("corrected question");
    expect(page.history.totalItems).toBe(2);
    const fallback = await readThreadFromJsonl(file, "thread");
    expect(JSON.stringify(fallback)).not.toContain("remove me");
    expect(JSON.stringify(fallback)).toContain("corrected question");
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("loads a deferred parallel tool result by stable call id", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-index-tool-"));
  vi.stubEnv("CODEX_THREAD_INDEX_DB", path.join(root, "index.sqlite"));
  vi.stubEnv("CODEX_WEB_CODEX_SESSION_ROOTS", root);
  vi.resetModules();
  try {
    const filePath = path.join(root, "rollout-thread.jsonl");
    const records = [
      { type: "session_meta", payload: { id: "thread" } },
      { type: "turn_context", payload: { turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", id: "response-a", call_id: "call-a", name: "exec", input: "a()" } },
      { type: "response_item", payload: { type: "custom_tool_call", id: "response-b", call_id: "call-b", name: "exec", input: "b()" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", id: "out-b", call_id: "call-b", output: "output B" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", id: "out-a", call_id: "call-a", output: "output A" } }
    ];
    await fs.writeFile(filePath, records.map((payload, i) => JSON.stringify({ timestamp: new Date(1700000000000 + i * 1000).toISOString(), ...payload })).join("\n") + "\n");
    const { readIndexedThreadItem } = await import("./threadEventIndex.js");
    expect(await readIndexedThreadItem(filePath, "thread", "call-a")).toMatchObject({ id: "out-a", aggregatedOutput: "output A" });
    expect(await readIndexedThreadItem(filePath, "thread", "call-b")).toMatchObject({ id: "out-b", aggregatedOutput: "output B" });
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
