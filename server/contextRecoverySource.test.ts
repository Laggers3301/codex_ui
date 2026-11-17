import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readContextRecoverySource } from "./contextRecoverySource.js";

it("recovers concrete tasks across oversized tool lines, without replaying internal instructions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "context-source-"));
  const file = path.join(dir, "rollout.jsonl");
  const record = (type: string, message: string) => JSON.stringify({ type: "event_msg", timestamp: "fixture", payload: { type, ...(type === "task_complete" ? { last_agent_message: message } : { message }) } });
  try {
    await fs.writeFile(file, [
      record("user_message", "对未知物体接入 BundleSDF 和 CoACD，保留已有动作。"),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "SECRET_TOOL_RESULT".repeat(100000) } }),
      record("task_complete", "已完成接口；闭环验收仍待完成。"),
      record("user_message", "# AGENTS.md instructions for /fixture\n内部工作区约定"),
      record("user_message", "<codex_internal_context_recovery>\ninternal-only"),
      record("user_message", "继续，计算只在 H20 上。"),
      "malformed partial"
    ].join("\n"));
    const before = await fs.readFile(file);
    const text = await readContextRecoverySource(file);
    expect(text).toContain("BundleSDF"); expect(text).toContain("H20");
    expect(text).toContain("闭环验收仍待完成"); expect(text).toContain(file);
    expect(text).not.toContain("内部工作区约定"); expect(text).not.toContain("internal-only");
    expect(text).not.toContain("SECRET_TOOL_RESULT");
    expect(text.indexOf("BundleSDF")).toBeLessThan(text.indexOf("H20"));
    expect(text.length).toBeLessThan(32000);
    // Byte-for-byte equality. Not toEqual(): vitest compares a 1.8 MB Buffer element by element (~2.8 s).
    expect((await fs.readFile(file)).equals(before)).toBe(true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
