import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import { CodexBridge } from "./codexBridge.js";
import { appendLegacyRollbackMarker, removeAppendedRollbackMarker } from "./legacyRollback.js";

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

const localCodex = path.resolve(process.cwd(), "../bin/codex-0.156.0/codex");
describe.skipIf(!((await fs.stat(localCodex).catch(() => null))?.isFile()))("isolated legacy rollback replay", () => {
  it("keeps the original thread id and first turn after a guarded account restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-rollback-appserver-"));
    roots.push(root);
    const id = "443f9dfc-2692-4920-953e-b04cb2dc6c26";
    const day = path.join(root, "sessions", "2026", "09", "27");
    await fs.mkdir(day, { recursive: true });
    const file = path.join(day, `rollout-2026-09-27T22-00-00-${id}.jsonl`);
    const timestamp = "2026-09-27T14:00:00.000Z";
    const records: unknown[] = [{ timestamp, type: "session_meta", payload: { id, session_id: id, timestamp, cwd: process.cwd(), originator: "codex_web_console", cli_version: "0.156.0", source: "appServer", model_provider: "openai", history_mode: "legacy" } }];
    for (let n = 1; n <= 2; n += 1) {
      const turnId = `turn-${n}`;
      records.push({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: turnId, started_at: timestamp } });
      records.push({ timestamp, type: "event_msg", payload: { type: "user_message", message: `synthetic question ${n}`, images: [], local_images: [], text_elements: [] } });
      records.push({ timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `synthetic question ${n}` }] } });
      records.push({ timestamp, type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: `synthetic answer ${n}` } });
    }
    await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const pool = new AccountPoolBridge({ accounts: [{ id: "isolated", label: "isolated", codexHome: root }], stateFile: path.join(root, "pool-state.json") }, root,
      (codexHome) => new CodexBridge({ command: localCodex, args: ["app-server", "--listen", "stdio://"], env: { ...process.env, CODEX_HOME: codexHome } }));
    try {
      const before = await pool.request("thread/read", { threadId: id, includeTurns: true }) as { thread: { turns: { id: string }[] } };
      expect(before.thread.turns).toHaveLength(2);
      const lastTurnId = before.thread.turns[1].id;
      const result = await pool.rollbackLegacyLatest(id, lastTurnId) as { thread: { id: string; turns: { items: { content?: { text?: string }[] }[] }[] } };
      expect(result.thread.id).toBe(id);
      expect(result.thread.turns).toHaveLength(1);
      expect(result.thread.turns[0].items[0].content?.[0]?.text).toBe("synthetic question 1");
    } finally {
      pool.stop();
    }
  });
});
