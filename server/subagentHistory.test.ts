import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { configuredSubagentRuntimeHomes, findSubagentDescendant, listSubagentDescendants, readSubagentDirectoryPage, readSubagentTelemetry } from "./subagentHistory.js";

const tempDirs: string[] = [];
const previousPoolFile = process.env.CODEX_WEB_ACCOUNT_POOL_FILE;
const previousSessionRoots = process.env.CODEX_WEB_CODEX_SESSION_ROOTS;

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagent-history-"));
  tempDirs.push(directory);
  return directory;
}

function insertThread(db: DatabaseSync, id: string, source: unknown, overrides: Record<string, unknown> = {}): void {
  const row = {
    title: "",
    name: null,
    model: "gpt-6-luna",
    reasoning_effort: "high",
    agent_nickname: null,
    updated_at_ms: 1_790_000_000_000,
    ...overrides
  };
  db.prepare(`INSERT INTO threads (id, source, title, name, model, reasoning_effort, agent_nickname, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, JSON.stringify(source), row.title, row.name, row.model, row.reasoning_effort, row.agent_nickname, row.updated_at_ms);
}

function makeStateDb(runtimeHome: string): DatabaseSync {
  const db = new DatabaseSync(path.join(runtimeHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, title TEXT, name TEXT, model TEXT, reasoning_effort TEXT, agent_nickname TEXT, updated_at_ms INTEGER);`);
  return db;
}

afterEach(() => {
  vi.useRealTimers();
  if (previousPoolFile === undefined) delete process.env.CODEX_WEB_ACCOUNT_POOL_FILE;
  else process.env.CODEX_WEB_ACCOUNT_POOL_FILE = previousPoolFile;
  if (previousSessionRoots === undefined) delete process.env.CODEX_WEB_CODEX_SESSION_ROOTS;
  else process.env.CODEX_WEB_CODEX_SESSION_ROOTS = previousSessionRoots;
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("subagent history metadata", () => {
  it("reads bounded status and model metadata without ingesting a huge tool-output line", async () => {
    const file = path.join(temporaryDirectory(), "child.jsonl");
    fs.writeFileSync(file, [
      { type: "turn_context", payload: { model: "gpt-6-luna", reasoning_effort: "high" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { output: "x".repeat(512 * 1024) } },
      { type: "event_msg", payload: { type: "task_complete" } }
    ].map(row => JSON.stringify(row)).join("\n"));
    expect(await readSubagentTelemetry(file)).toEqual({ state: "completed", model: "gpt-6-luna", reasoningEffort: "high" });
  });
  it("does not call silence an interruption or confuse tool completion with task completion", async () => {
    const file = path.join(temporaryDirectory(), "child.jsonl");
    fs.writeFileSync(file, [
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", payload: { type: "exec_command_end" } }
    ].map(row => JSON.stringify(row)).join("\n"));
    expect((await readSubagentTelemetry(file)).state).toBe("running");
    fs.utimesSync(file, new Date(0), new Date(0));
    expect((await readSubagentTelemetry(file)).state).toBe("unknown");
    fs.appendFileSync(file, '\n{"type":"event_msg","payload":{"type":"turn_aborted"}}');
    expect((await readSubagentTelemetry(file)).state).toBe("interrupted");
  });
  it("returns only bounded descendants attached to a parent in the same runtime DB", () => {
    const firstHome = path.join(temporaryDirectory(), "runtime-a");
    const secondHome = path.join(temporaryDirectory(), "runtime-b");
    fs.mkdirSync(firstHome);
    fs.mkdirSync(secondHome);
    const first = makeStateDb(firstHome);
    insertThread(first, "parent", {});
    insertThread(first, "child", { subagent: { thread_spawn: { parent_thread_id: "parent", agent_path: "/root/worker" } } }, { agent_nickname: "Ariadne" });
    insertThread(first, "grandchild", { subagent: { thread_spawn: { parent_thread_id: "child" } } });
    insertThread(first, "unrelated", { subagent: { thread_spawn: { parent_thread_id: "other-parent" } } });
    const second = makeStateDb(secondHome);
    insertThread(second, "child-from-copy", { subagent: { thread_spawn: { parent_thread_id: "parent" } } });
    first.close();
    second.close();

    const records = listSubagentDescendants("parent", [firstHome], 1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "child", parentThreadId: "parent", name: "/root/worker", runtimeHome: firstHome });
    expect(listSubagentDescendants("parent", [secondHome])).toEqual([]);
    expect(listSubagentDescendants("parent", [firstHome]).map((record) => [record.id, record.parentThreadId]))
      .toEqual([["child", "parent"], ["grandchild", "child"]]);
  });

  it("paginates every direct descendant and keeps ancestry checks beyond the legacy 64-row cap", async () => {
    const home = path.join(temporaryDirectory(), "runtime"); fs.mkdirSync(home);
    const db = makeStateDb(home); insertThread(db, "parent", {});
    for (let index = 0; index < 72; index++) insertThread(db, `child-${String(index).padStart(2, "0")}`, { subagent: { thread_spawn: { parent_thread_id: "parent" } } }, { name: `Worker ${index}`, updated_at_ms: 1_790_000_000_000 + index });
    db.close();
    expect(listSubagentDescendants("parent", [home])).toHaveLength(64);
    expect(findSubagentDescendant("parent", "child-00", [home])?.id).toBe("child-00");
    const first = await readSubagentDirectoryPage("parent", [home], { limit: 40 });
    expect(first.data).toHaveLength(40);
    expect(first.page).toMatchObject({ total: 72, matchedCount: 72, historyCount: 72, unknownCount: 72, hasMore: true });
    const changed = new DatabaseSync(path.join(home, "state_5.sqlite"));
    // A polling update can move the old boundary to the beginning. The cursor
    // carries its keyset position, not an index into today's mutable array.
    changed.prepare("UPDATE threads SET updated_at_ms = ? WHERE id = ?").run(1_790_000_010_000, first.data.at(-1)!.id);
    changed.close();
    const second = await readSubagentDirectoryPage("parent", [home], { limit: 40, cursor: first.page.nextCursor! });
    expect(second.page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(new Set([...first.data, ...second.data].map(row => row.id)).size).toBe(72);
    expect((await readSubagentDirectoryPage("parent", [home], { view: "history", q: "Worker 7", limit: 100 })).page.matchedCount).toBe(3);
    expect((await readSubagentDirectoryPage("parent", [home], { view: "history", q: "child-00", limit: 100 })).page.matchedCount).toBe(1);
    await expect(readSubagentDirectoryPage("parent", [home], { cursor: "bogus" })).rejects.toThrow("Invalid subagent cursor");
    await expect(readSubagentDirectoryPage("parent", [home], { view: "active", cursor: first.page.nextCursor! })).rejects.toThrow("Invalid subagent cursor");
  });

  it("sees live WAL inserts and resolves native rollout filenames with real task dates", async () => {
    const home = path.join(temporaryDirectory(), "runtime"), sessions = path.join(home, "sessions", "2026", "10", "02");
    fs.mkdirSync(sessions, { recursive: true });
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, title TEXT, name TEXT, model TEXT, reasoning_effort TEXT, agent_nickname TEXT, updated_at_ms INTEGER, created_at_ms INTEGER);`);
    insertThread(db, "parent", {});
    const first = await readSubagentDirectoryPage("parent", [home]);
    expect(first.page.total).toBe(0);
    insertThread(db, "native-child", { subagent: { thread_spawn: { parent_thread_id: "parent" } } }, { created_at_ms: 1_790_000_000_000 });
    db.prepare("UPDATE threads SET created_at_ms = ? WHERE id = ?").run(1_790_000_000_000, "native-child");
    const nativePath = path.join(sessions, "rollout-2026-10-02T11-22-33-native-child.jsonl");
    fs.writeFileSync(nativePath, JSON.stringify({ type: "event_msg", timestamp: "2026-10-02T11:22:33.000Z", payload: { type: "task_started" } }) + "\n");
    const page = await readSubagentDirectoryPage("parent", [home]);
    expect(page.page.total).toBe(1);
    expect(page.data[0]).toMatchObject({ id: "native-child", state: "running", createdAt: new Date(1_790_000_000_000).toISOString(), lastTaskAt: "2026-10-02T11:22:33.000Z" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 121_000));
    expect((await readSubagentDirectoryPage("parent", [home])).data[0].state).toBe("unknown");
    vi.useRealTimers();
    db.close();
  });

  it("uses the existing parent-to-account pin when it is available", () => {
    const temporary = temporaryDirectory();
    const firstHome = path.join(temporary, "runtime-a");
    const secondHome = path.join(temporary, "runtime-b");
    fs.mkdirSync(firstHome);
    fs.mkdirSync(secondHome);
    const stateFile = path.join(temporary, "pool-state.json");
    const poolFile = path.join(temporary, "pool.json");
    fs.writeFileSync(stateFile, JSON.stringify({ threadAccounts: { parent: "b" } }));
    fs.writeFileSync(poolFile, JSON.stringify({
      stateFile: "pool-state.json",
      accounts: [{ id: "a", codexHome: firstHome }, { id: "b", codexHome: secondHome }]
    }));
    process.env.CODEX_WEB_ACCOUNT_POOL_FILE = poolFile;
    expect(configuredSubagentRuntimeHomes("parent")).toEqual([secondHome]);
  });

  it("authorizes the parent first, rejects unrelated child IDs, and reads a child without creating an owner", async () => {
    const temporary = temporaryDirectory();
    const runtimeHome = path.join(temporary, "runtime");
    const sessionsRoot = path.join(runtimeHome, "sessions", "2026", "10", "02");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const parentId = "parent-thread";
    const childId = "child-thread";
    const filePath = path.join(sessionsRoot, `rollout-${childId}.jsonl`);
    fs.writeFileSync(filePath, [
      { type: "session_meta", payload: { id: childId, session_id: childId, history_mode: "legacy" } },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "event_msg", timestamp: "2026-10-02T00:00:00.000Z", payload: { type: "task_started", turn_id: "turn-1", started_at: 1790899200 } },
      { type: "response_item", timestamp: "2026-10-02T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "child record" }] } },
      { type: "event_msg", timestamp: "2026-10-02T00:00:02.000Z", payload: { type: "task_complete", turn_id: "turn-1", completed_at: 1790899202 } }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    const state = makeStateDb(runtimeHome);
    insertThread(state, parentId, {});
    insertThread(state, childId, { subagent: { thread_spawn: { parent_thread_id: parentId } } }, { agent_nickname: "Worker" });
    insertThread(state, "unrelated-child", { subagent: { thread_spawn: { parent_thread_id: "another-parent" } } });
    state.close();
    const poolFile = path.join(temporary, "pool.json");
    fs.writeFileSync(poolFile, JSON.stringify({ accounts: [{ id: "a", codexHome: runtimeHome }] }));
    process.env.CODEX_WEB_ACCOUNT_POOL_FILE = poolFile;
    process.env.CODEX_WEB_CODEX_SESSION_ROOTS = path.join(runtimeHome, "sessions");
    const { registerRoutes } = await import("./routes.js");

    const store = new ProjectStore(path.join(temporary, "app.sqlite"));
    const project = store.createProject({ name: "test", rootPath: temporary });
    store.registerThreadOwner({ threadId: parentId, userId: "admin", projectId: project.id, rootPath: temporary });
    const app = Fastify();
    const bridge = { request: vi.fn(async () => ({})) } as unknown as CodexBridge;
    try {
      registerRoutes(app, bridge, store, { backgroundIndexing: false });
      const list = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads/${parentId}/subagents` });
      expect(list.statusCode).toBe(200);
      expect(list.json().data).toMatchObject([{ id: childId, name: "Worker", parentThreadId: parentId, state: "completed" }]);
      expect(list.json().page).toMatchObject({ total: 1, matchedCount: 1, activeCount: 0, historyCount: 1, unknownCount: 0, hasMore: false, nextCursor: null });
      expect(list.json().data[0]).not.toHaveProperty("runtimeHome");
      const idSearch = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads/${parentId}/subagents?q=${childId}` });
      expect(idSearch.json().page).toMatchObject({ total: 1, matchedCount: 1 });
      expect(idSearch.json().data[0].id).toBe(childId);
      expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads/${parentId}/subagents?view=invalid` })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads/${parentId}/subagents?cursor=bogus` })).statusCode).toBe(400);
      const history = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads/${parentId}/subagents/${childId}?limit=128` });
      expect(history.statusCode, JSON.stringify(history.json())).toBe(200);
      expect(JSON.stringify(history.json())).toContain("child record");
      const foreignChild = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads/${parentId}/subagents/unrelated-child` });
      expect(foreignChild.statusCode).toBe(404);
      const unrelatedOutput = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads/${parentId}/subagents/unrelated-child/items/call-1/output` });
      expect(unrelatedOutput.statusCode).toBe(404);
      const deniedParent = await app.inject({ method: "GET", url: `/api/projects/${project.id}/threads/not-owned/subagents/${childId}` });
      expect(deniedParent.statusCode).toBe(403);
      expect(store.getThreadOwner(childId)).toBeNull();
      expect(bridge.request).not.toHaveBeenCalled();
    } finally {
      await app.close();
      store.close();
    }
  });
});
