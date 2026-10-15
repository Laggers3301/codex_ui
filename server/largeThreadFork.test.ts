import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {gunzipSync} from "node:zlib";
import {toolArchivePath} from "./toolOutputArchive.js";
import { describe, it, expect } from "vitest";
import { assertLargeBranchMemory, BranchGate, copyLargeThreadBranch, isLegacyRollout } from "./largeThreadFork.js";

const event = (type: string, fields = {}) => ({ type: "event_msg", payload: { type, ...fields } });
const turn = (id: string) => [event("task_started", { turn_id: id }),
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `问题 ${id} 中文🙂` }] } },
  { type: "response_item", payload: { type: "custom_tool_call_output", output: `tool ${id}` } },
  event("task_complete", { turn_id: id })];
async function fixture(run: (o: { root: string; source: string; sourcePath: string; sourceSessionsRoot: string; targetSessionsRoot: string; sourceThreadId: string; cwd: string }) => Promise<void>, rows: unknown[] = [...turn("one"), ...turn("two")], suffix = "") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "large-fork-test-"));
  const sourceSessionsRoot = path.join(root, "source", "sessions");
  await fs.mkdir(sourceSessionsRoot, { recursive: true });
  const sourcePath = path.join(sourceSessionsRoot, "rollout.jsonl");
  const metadata = { timestamp: "2026-10-01T01:00:00Z", type: "session_meta", payload: {
    id: "source-id", history_mode: "legacy", base_instructions: { text: "keep original" }, source: "cli" } };
  const source = [metadata, ...rows].map(row => JSON.stringify(row)).join("\n") + "\n" + suffix;
  await fs.writeFile(sourcePath, source);
  try { await run({ root, source, sourcePath, sourceSessionsRoot, targetSessionsRoot: path.join(root, "target", "sessions"), sourceThreadId: "source-id", cwd: root }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

describe("bounded exact legacy branch", () => {
  it("archives only older oversized outputs, preserving two recent turns and complete original records",()=>fixture(async options=>{
    const archiveRoot=path.join(options.root,"private-archives");
    const copied=await copyLargeThreadBranch({...options,lastTurnId:"four",toolArchiveRoot:archiveRoot});
    const result=(await fs.readFile(copied.path,"utf8")).trimEnd().split("\n").map(line=>JSON.parse(line));
    const outputs=result.filter(row=>row.type==="response_item"&&row.payload.type==="custom_tool_call_output");
    expect(outputs[0].payload.output).toContain("已精简");expect(outputs[1].payload.output).toContain("已精简");
    expect(outputs[2].payload.output).toBe(`three:${"x".repeat(200000)}:END`);expect(outputs[3].payload.output).toBe(`four:${"x".repeat(200000)}:END`);
    expect(outputs.map(row=>row.payload.call_id)).toEqual(["one","two","three","four"]);
    expect(copied.toolArchive).toMatchObject({archivedRecords:2,keptRecentTurnIds:["three","four"]});
    const archive=toolArchivePath(archiveRoot,copied.threadId),rows=gunzipSync(await fs.readFile(archive)).toString("utf8").trimEnd().split("\n").map(line=>JSON.parse(line));
    expect(rows.filter(row=>row.type==="response_item").map(row=>row.payload.output)).toEqual([`one:${"x".repeat(200000)}:END`,`two:${"x".repeat(200000)}:END`]);
    expect((await fs.stat(archive)).mode&0o777).toBe(0o600);
    expect(await fs.readFile(options.sourcePath,"utf8")).toBe(options.source);
  },["one","two","three","four"].flatMap(id=>[event("task_started",{turn_id:id}),{type:"response_item",payload:{type:"custom_tool_call_output",call_id:id,internal_chat_message_metadata_passthrough:{turn_id:id},output:`${id}:${"x".repeat(200000)}:END`}},event("task_complete",{turn_id:id})])));
  it("copies only through the selected terminal turn, preserving every body byte", () => fixture(async options => {
    const copied = await copyLargeThreadBranch({ ...options, lastTurnId: "one" });
    const result = await fs.readFile(copied.path, "utf8");
    const end = options.source.indexOf(JSON.stringify(event("task_started", { turn_id: "two" })));
    expect(result.slice(result.indexOf("\n") + 1)).toBe(options.source.slice(options.source.indexOf("\n") + 1, end));
    expect(JSON.parse(result.split("\n")[0]).payload).toMatchObject({ id: copied.threadId, forked_from_id: "source-id", base_instructions: { text: "keep original" }, history_mode: "legacy", cwd: options.root });
    expect((await fs.stat(copied.path)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(options.sourcePath, "utf8")).toBe(options.source);
  }));

  it("keeps large tool/image data and compaction checkpoints verbatim, omitting partial tail", () => fixture(async options => {
    const copied = await copyLargeThreadBranch({ ...options, lastTurnId: "one" });
    const result = await fs.readFile(copied.path, "utf8");
    expect(result.slice(result.indexOf("\n") + 1)).toBe(options.source.slice(options.source.indexOf("\n") + 1).replace('{"incomplete":', ""));
    expect(await fs.readFile(options.sourcePath, "utf8")).toBe(options.source);
  }, [event("task_started", { turn_id: "one" }),
    { type: "response_item", payload: { type: "custom_tool_call_output", output: "图像🙂".repeat(100000) } },
    { type: "compacted", payload: { replacement_history: [{ type: "message", role: "assistant", content: "exact context" }] } },
    event("task_complete", { turn_id: "one" })], '{"incomplete":'));

  it("rejects running turns without creating a target directory", () => fixture(async options => {
    await expect(copyLargeThreadBranch({ ...options, lastTurnId: "one" })).rejects.toThrow(/还未结束/);
    await expect(fs.stat(options.targetSessionsRoot)).rejects.toThrow();
  }, [event("task_started", { turn_id: "one" })]));

  it("rejects rolled-back and missing turns", () => fixture(async options => {
    await expect(copyLargeThreadBranch({ ...options, lastTurnId: "two" })).rejects.toThrow(/已经撤回/);
    await expect(copyLargeThreadBranch({ ...options, lastTurnId: "missing" })).rejects.toThrow(/不存在/);
    await expect(copyLargeThreadBranch({ ...options, lastTurnId: "one" })).resolves.toHaveProperty("threadId");
  }, [...turn("one"), ...turn("two"), event("thread_rolled_back", { num_turns: 1 })]));

  it("supports interrupted turns", () => fixture(async options => {
    await expect(copyLargeThreadBranch({ ...options, lastTurnId: "one" })).resolves.toHaveProperty("threadId");
  }, [event("task_started", { turn_id: "one" }), event("turn_aborted", { turn_id: "one", reason: "interrupted" })]));

  it("rejects a different owner, header ID and duplicate boundary", () => fixture(async options => {
    await fs.mkdir(path.join(options.root, "other"));
    await expect(copyLargeThreadBranch({ ...options, lastTurnId: "one", sourceSessionsRoot: path.join(options.root, "other") })).rejects.toThrow(/不在所属账号/);
    await expect(copyLargeThreadBranch({ ...options, lastTurnId: "one", sourceThreadId: "not-owner" })).rejects.toThrow(/标识不匹配/);
    await expect(copyLargeThreadBranch({ ...options, lastTurnId: "one" })).rejects.toThrow(/重复/);
  }, [...turn("one"), ...turn("one")]));

  it("leaves paginated histories to native fork instead of converting references", () => fixture(async options => {
    expect(await isLegacyRollout(options.sourcePath)).toBe(true);
    const rows = options.source.trimEnd().split("\n");
    const metadata = JSON.parse(rows[0]);
    metadata.payload.history_mode = "paginated";
    rows[0] = JSON.stringify(metadata);
    await fs.writeFile(options.sourcePath, rows.join("\n") + "\n");
    expect(await isLegacyRollout(options.sourcePath)).toBe(false);
    await expect(copyLargeThreadBranch({ ...options, lastTurnId: "one" })).rejects.toThrow(/分页历史/);
  }));

  it("prevents concurrent forks and releases exactly once", () => {
    const gate = new BranchGate();
    const release = gate.enter();
    expect(() => gate.enter()).toThrow(/已有分支/);
    release();
    const next = gate.enter();
    release();
    expect(() => gate.enter()).toThrow(/已有分支/);
    next();
    expect(() => gate.enter()).not.toThrow();
  });

  it("refuses a large hydration while memory is pressured", () => {
    expect(() => assertLargeBranchMemory(900e6, 2e9)).toThrow(/可用内存不足/);
    expect(() => assertLargeBranchMemory(900e6, 5e9)).not.toThrow();
  });
});
