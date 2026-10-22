import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {zstdCompressSync} from 'node:zlib';
import {readableRolloutPath} from './rolloutStorage.js';
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import { CodexBridge } from "./codexBridge.js";
import { appendLegacyRollbackMarker, removeAppendedRollbackMarker, readLegacyTailMetadata } from "./legacyRollback.js";
import { ProjectStore } from "./db.js";
import { registerRoutes } from "./routes.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(historyMode = "legacy") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-rollback-test-"));
  roots.push(root);
  const id = "00000000-0000-0000-0000-000000000001";
  const dir = path.join(root, "sessions", "2026", "09", "27");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-27T00-00-00-${id}.jsonl`);
  const original = `${JSON.stringify({ type: "session_meta", payload: { id, history_mode: historyMode } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`;
  await fs.writeFile(file, original);
  return { root, id, file, original };
}

describe("legacy rollback marker", () => {
  it("appends the compatible marker and can restore the exact original bytes", async () => {
    const { root, id, file, original } = await fixture();
    const marker = await appendLegacyRollbackMarker(root, file, id);
    const rows = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } });
    await removeAppendedRollbackMarker(marker);
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it("rejects a paginated rollout or a path outside the owning account", async () => {
    const paginated = await fixture("paginated");
    await expect(appendLegacyRollbackMarker(paginated.root, paginated.file, paginated.id)).rejects.toThrow("legacy thread");
    const legacy = await fixture();
    await expect(appendLegacyRollbackMarker(paginated.root, legacy.file, legacy.id)).rejects.toThrow("requested account");
  });

  it("will not truncate another writer's appended records", async () => {
    const { root, id, file } = await fixture();
    const marker = await appendLegacyRollbackMarker(root, file, id);
    await fs.appendFile(file, "{}\n");
    await expect(removeAppendedRollbackMarker(marker)).rejects.toThrow("another writer");
  });
});

describe("bounded latest-turn metadata", () => {
  const line = (payload: unknown) => JSON.stringify(payload) + "\n";
  const turn = (id: string, complete = true) => [
    { type: "event_msg", payload: { type: "task_started", turn_id: id } },
    { type: "turn_context", payload: { turn_id: id } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] } },
    ...(complete ? [{ type: "event_msg", payload: { type: "task_complete", turn_id: id } }] : [])
  ].map(line).join("");
  it("reads only metadata, respects rollback markers, and distinguishes a running turn", async () => {
    const f = await fixture();
    await fs.appendFile(f.file, turn("first") + turn("second") + line({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }) + turn("replacement", false));
    const metadata = await readLegacyTailMetadata(f.file);
    expect(metadata.latest).toEqual({ id: "replacement", status: "running", hasUserMessage: true });
    expect(metadata.previous?.id).toBe("first");
    expect(JSON.stringify(metadata)).not.toContain("question");
  });
  it("keeps memory bounded with an oversized latest-turn tool result", async () => {
    const f = await fixture();
    await fs.appendFile(f.file, turn("first") + turn("second", false));
    const handle = await fs.open(f.file, "a");
    try {
      await handle.write('{"type":"response_item","payload":{"type":"custom_tool_call_output","output":"');
      const chunk = "x".repeat(1024 * 1024);
      for (let i = 0; i < 16; i++) await handle.write(chunk);
      await handle.write('"}}\n' + line({ type: "event_msg", payload: { type: "task_complete", turn_id: "second" } }));
    } finally { await handle.close(); }
    const result = await readLegacyTailMetadata(f.file);
    expect(result.latest).toEqual({ id: "second", status: "completed", hasUserMessage: true });
    expect(result.previous?.id).toBe("first");
    expect(JSON.stringify(result).length).toBeLessThan(1024);
  });
  it("rejects incomplete records and files changed since metadata validation", async () => {
    const f = await fixture(); await fs.appendFile(f.file, turn("first"));
    const expected = await readLegacyTailMetadata(f.file);
    await fs.appendFile(f.file, turn("second"));
    await expect(appendLegacyRollbackMarker(f.root, f.file, f.id, expected)).rejects.toThrow("发生变化");
    await fs.appendFile(f.file, '{"type":');
    await expect(readLegacyTailMetadata(f.file)).rejects.toThrow("完整写入");
  });
  it("locates a historical turn in logical history without loading message bodies", async () => {
    const f=await fixture();
    await fs.appendFile(f.file,turn("first")+turn("second")+turn("third")+line({type:"event_msg",payload:{type:"thread_rolled_back",num_turns:1}})+turn("replacement"));
    const metadata=await readLegacyTailMetadata(f.file,"second");
    expect(metadata.latest?.id).toBe("replacement");
    expect(metadata.target?.id).toBe("second");
    expect(metadata.rollbackTurns).toBe(2);
    expect(metadata.retainedPrevious?.id).toBe("first");
    const marker=await appendLegacyRollbackMarker(f.root,f.file,f.id,metadata,metadata.rollbackTurns);
    expect((await readLegacyTailMetadata(f.file)).latest?.id).toBe("first");
    await removeAppendedRollbackMarker(marker);
    expect((await readLegacyTailMetadata(f.file)).latest?.id).toBe("replacement");
    expect((await readLegacyTailMetadata(f.file,"missing")).target).toBeNull();
    await expect(appendLegacyRollbackMarker(f.root,f.file,f.id,undefined,0)).rejects.toThrow("轮数无效");
  });
});

const localCodex = process.env.CODEX_ROLLBACK_TEST_BIN ?? path.resolve(process.cwd(), "../bin/codex-0.162.1/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex");
describe.skipIf(!((await fs.stat(localCodex).catch(() => null))?.isFile()))("isolated legacy rollback replay", () => {
  it.each([{compressed:false,target:3},{compressed:true,target:3},{compressed:false,target:2},{compressed:true,target:2},{compressed:false,target:1}])("keeps the same thread and reconstructs retained history after edit (%j)", async ({compressed,target}) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-rollback-appserver-"));
    roots.push(root);
    const id = "443f9dfc-2692-4920-953e-b04cb2dc6c26";
    const day = path.join(root, "sessions", "2026", "09", "27");
    await fs.mkdir(day, { recursive: true });
    const file = path.join(day, `rollout-2026-09-27T22-00-00-${id}.jsonl`);
    const timestamp = "2026-09-27T14:00:00.000Z";
    const records: unknown[] = [{ timestamp, type: "session_meta", payload: { id, session_id: id, timestamp, cwd: process.cwd(), originator: "codex_web_console", cli_version: "0.156.0", source: "appServer", model_provider: "openai", history_mode: "legacy" } }];
    for (let n = 1; n <= 3; n += 1) {
      const turnId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      records.push({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: turnId, started_at: timestamp } });
      records.push({ timestamp, type: "event_msg", payload: { type: "user_message", message: `synthetic question ${n}`, images: [], local_images: [], text_elements: [] } });
      records.push({ timestamp, type: "response_item", payload: { type: "message", role: "user", internal_chat_message_metadata_passthrough: { turn_id: turnId }, content: [{ type: "input_text", text: `synthetic question ${n}` }] } });
      records.push({ timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: `synthetic answer ${n}` } });
    }
    await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    if(compressed){await fs.writeFile(file+'.zst',zstdCompressSync(await fs.readFile(file)));await fs.unlink(file);}
    const runtimes: CodexBridge[] = [];
    const pool = new AccountPoolBridge({ accounts: [{ id: "isolated", label: "isolated", codexHome: root }], stateFile: path.join(root, "pool-state.json") }, root,
      (codexHome) => {
        const runtime = new CodexBridge({ command: localCodex, args: ["app-server", "--listen", "stdio://"], env: { ...process.env, CODEX_HOME: codexHome } });
        runtimes.push(runtime);
        return runtime;
      });
    const store = new ProjectStore(path.join(root, "test.sqlite"));
    const project = store.createProject({ name: "rollback test", rootPath: root });
    store.registerThreadOwner({ threadId: id, userId: "admin", projectId: project.id, rootPath: root });
    const app = Fastify();
    registerRoutes(app, pool as unknown as CodexBridge, store, { backgroundIndexing: false });
    try {
      const before = await pool.request("thread/read", { threadId: id, includeTurns: true }) as { thread: { turns: { id: string }[] } };
      expect(before.thread.turns).toHaveLength(3);
      // The Web history index exposes persisted turn IDs; native legacy
      // thread/read can instead synthesize positional rollout-N identifiers.
      const lastTurnId = (await readLegacyTailMetadata(await readableRolloutPath(file))).latest!.id;
      const stale = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/${id}/edit-latest`, payload: { turnId: before.thread.turns[0].id } });
      expect(stale.statusCode).toBe(409);
      expect((await pool.request("thread/read", { threadId: id, includeTurns: true }) as typeof before).thread.turns).toHaveLength(3);
      if(target<3) {
        const changed=await app.inject({method:"POST",url:`/api/projects/${project.id}/threads/${id}/edit-latest`,payload:{turnId:`00000000-0000-4000-8000-${String(target).padStart(12,"0")}`,expectedLatestTurnId:"stale-latest",allowHistoryRewrite:true}});
        expect(changed.statusCode).toBe(409);
      }
      const requests = vi.spyOn(runtimes[0], "request");
      const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/threads/${id}/edit-latest`, payload: {
        turnId:`00000000-0000-4000-8000-${String(target).padStart(12,"0")}`,
        ...(target<3?{expectedLatestTurnId:lastTurnId,allowHistoryRewrite:true}:{})
      } });
      expect(response.statusCode, response.body).toBe(200);
      expect(requests.mock.calls.filter(([method, params]) => method === "thread/read" && (params as { includeTurns?: boolean })?.includeTurns)).toHaveLength(0);
      expect(response.body.length).toBeLessThan(1024);
      const result = response.json().data as { thread: { id: string; turns: { items: { content?: { text?: string }[] }[] }[] } };
      expect(result.thread.id).toBe(id);
      expect(result.thread.turns).toHaveLength(0);
      // A fresh resume must reconstruct the same history, not just hide it
      // in the first read response.
      const resumed = await pool.request("thread/resume", { threadId: id, cwd: process.cwd(), excludeTurns: true }) as typeof result;
      expect(resumed.thread.turns).toHaveLength(0);
      const reread = await pool.request("thread/read", { threadId: id, includeTurns: true }) as typeof result;
      expect(reread.thread.turns).toHaveLength(target-1);
      if(target>1)expect(reread.thread.turns[0].items[0].content?.[0]?.text).toBe("synthetic question 1");
      expect(JSON.stringify(reread.thread.turns)).not.toContain(`synthetic question ${target}`);
      // The compatibility marker does not physically destroy the old records.
      expect(await fs.readFile(file,"utf8")).toContain("synthetic question 3");
    } finally {
      await app.close();
      store.close();
      await Promise.all(runtimes.map((runtime) => runtime.stopAndWait()));
      pool.stop();
    }
  });
});
