import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readThreadFromJsonl, readThreadSummaryFromJsonl, threadJsonlSessionsRoot } from "./threadFallback.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("forked JSONL recovery", () => {
  it("preserves call correlation, record time and output identity across byte-range pages", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-fallback-tools-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "rollout-tools.jsonl");
    const records = [
      { type: "session_meta", payload: { id: "tools" } },
      { type: "turn_context", payload: { turn_id: "turn" } },
      { timestamp: "2026-09-16T01:00:00Z", type: "response_item", payload: { type: "custom_tool_call", id: "response-call", call_id: "call", name: "exec", description: "检查配置", input: "run()" } },
      { timestamp: "2026-09-16T01:00:01Z", type: "response_item", payload: { type: "custom_tool_call_output", id: "response-output", call_id: "call", output: "done" } }
    ];
    const lines = records.map((record) => JSON.stringify(record) + "\n");
    await fs.writeFile(filePath, lines.join(""));
    const full = await readThreadFromJsonl(filePath, "tools", root);
    const page = await readThreadFromJsonl(filePath, "tools", root, { startOffset: Buffer.byteLength(lines.slice(0, 3).join("")), syntheticTurnId: "turn" });
    const fullItems = (full.thread.turns as { items: Record<string, unknown>[] }[])[0].items;
    const pageItems = (page.thread.turns as { items: Record<string, unknown>[] }[])[0].items;
    expect(fullItems[0]).toMatchObject({ callId: "call", timelineAt: "2026-09-16T01:00:00Z", description: "检查配置", command: "run()" });
    expect(pageItems[0]).toEqual(fullItems[1]);
    expect(pageItems[0]).toMatchObject({ id: "response-output", callId: "call" });
  });
  it("resolves the owning history root for a disabled-account rollout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-fallback-root-"));
    temporaryRoots.push(root);
    const sessionsRoot = path.join(root, "sessions");
    const filePath = path.join(sessionsRoot, "2026", "09", "rollout-thread.jsonl");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{}\n");

    expect(threadJsonlSessionsRoot(filePath, sessionsRoot)).toBe(sessionsRoot);
    expect(threadJsonlSessionsRoot(path.join(root, "outside.jsonl"), sessionsRoot)).toBeNull();
  });

  it("keeps the real user preview and hides continuation recovery across JSONL formats", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-fallback-continuation-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "rollout-thread.jsonl");
    const recovery = "<codex_internal_continuation_recovery>\nContinue immediately\n</codex_internal_continuation_recovery>";
    const records = [
      { type: "session_meta", payload: { id: "thread" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "response_item", payload: { type: "message", role: "user", id: "prompt", content: [{ type: "input_text", text: "真正的用户问题" }] } },
      { type: "turn_context", payload: { turn_id: "turn-2" } },
      { type: "event_msg", payload: { type: "user_message", message: recovery } },
      { type: "response_item", payload: { type: "message", role: "user", id: "internal", content: [{ type: "input_text", text: recovery }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", id: "answer", content: [{ type: "output_text", text: "最终答复" }] } }
    ];
    await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const summary = await readThreadSummaryFromJsonl(filePath, "thread", root);
    expect(summary?.preview).toBe("真正的用户问题");
    const recovered = await readThreadFromJsonl(filePath, "thread", root);
    const items = (recovered.thread.turns as Array<{ items: Array<{ id: string }> }>).flatMap((turn) => turn.items);
    expect(items.map((item) => item.id)).toEqual(["prompt", "answer"]);
    expect(JSON.stringify(recovered)).not.toContain("codex_internal_continuation_recovery");
  });

  it("keeps the branch metadata and hides the injected AGENTS prelude", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-fallback-fork-"));
    temporaryRoots.push(root);
    const sessionsRoot = path.join(root, "sessions");
    const filePath = path.join(sessionsRoot, "2026", "09", "rollout-branch-thread.jsonl");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const internalPrelude = "# AGENTS.md instructions\n\n<INSTRUCTIONS>\ninternal\n</INSTRUCTIONS>\n<environment_context>\n<context/>\n</environment_context>";
    const records = [
      { timestamp: "2026-09-14T02:00:00Z", type: "session_meta", payload: { id: "branch-thread", session_id: "branch-thread", forked_from_id: "source-thread", timestamp: "2026-09-14T02:00:00Z" } },
      { timestamp: "2026-09-14T02:00:00Z", type: "session_meta", payload: { id: "source-thread", session_id: "source-thread", timestamp: "2026-09-01T02:00:00Z" } },
      { timestamp: "2026-09-14T02:00:01Z", type: "turn_context", payload: { turn_id: "turn-1" } },
      { timestamp: "2026-09-14T02:00:01Z", type: "response_item", payload: { type: "message", role: "user", id: "internal", content: [{ type: "input_text", text: internalPrelude }] } },
      { timestamp: "2026-09-14T02:00:02Z", type: "response_item", payload: { type: "message", role: "user", id: "prompt", content: [{ type: "input_text", text: "继续这个分支" }] } }
    ];
    await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const summary = await readThreadSummaryFromJsonl(filePath, "branch-thread", sessionsRoot);
    expect(summary).toMatchObject({ id: "branch-thread", sessionId: "branch-thread", preview: "继续这个分支" });

    const recovered = await readThreadFromJsonl(filePath, "branch-thread", sessionsRoot);
    expect(recovered.thread).toMatchObject({ id: "branch-thread", sessionId: "branch-thread", preview: "继续这个分支" });
    expect((recovered.thread.turns as Array<{ items: Array<{ id: string }> }>).flatMap((turn) => turn.items).map((item) => item.id)).toEqual(["prompt"]);
  });
});

describe("thread summary cache", () => {
  it("serves an unchanged file from memory, hands out independent copies, and notices every change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thread-summary-cache-"));
    temporaryRoots.push(root);
    const filePath = path.join(root, "rollout-cache.jsonl");
    const write = (extra = "") => fs.writeFile(filePath, [
      { type: "session_meta", payload: { id: "cached", timestamp: "2026-09-16T01:00:00Z", cwd: "/work" } },
      { type: "event_msg", payload: { type: "user_message", message: `第一条问题${extra}` } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    await write();
    // Whole-second timestamps survive a utimes round-trip exactly (nanosecond ones would not).
    await fs.utimes(filePath, 1_700_000_000, 1_700_000_000);
    const first = await readThreadSummaryFromJsonl(filePath, "cached", root);
    expect(first.preview).toBe("第一条问题");
    // Prove the second read never touches the file: overwrite it with same-length different
    // text and restore the old mtime. Same inode/size/mtime means "unchanged" to the cache.
    const before = await fs.stat(filePath);
    await write("").then(() => fs.readFile(filePath, "utf8")).then((text) => fs.writeFile(filePath, text.replace("第一条问题", "第二条问题")));
    await fs.utimes(filePath, 1_700_000_000, 1_700_000_000);
    expect((await fs.stat(filePath)).size).toBe(before.size);
    const second = await readThreadSummaryFromJsonl(filePath, "cached", root);
    expect(second.preview).toBe("第一条问题");
    expect(second).toEqual(first);
    // Mutating one caller's copy never leaks into the next caller.
    (second as Record<string, unknown>).name = "mutated"; (second.status as Record<string, unknown>).type = "mutated";
    const third = await readThreadSummaryFromJsonl(filePath, "cached", root);
    expect(third.name).toBe(first.name); expect((third.status as { type: string }).type).toBe("recoveredFromJsonl");
    // A rewrite (new size/mtime) is a miss, and the new content is read.
    await write("（已改）");
    expect((await readThreadSummaryFromJsonl(filePath, "cached", root)).preview).toBe("第一条问题（已改）");
  });
});
