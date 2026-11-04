import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSessionStorage, claudeConfigRoots, locateClaudeHistory, stageClaudeHistory } from "./claudeSessionStorage.js";
import { offlineFork } from "./claudeService.js";
import {DatabaseSync} from "node:sqlite";

const dirs: string[] = [];
const databases: ClaudeSessionStorage[] = [];
afterEach(() => { for (const db of databases.splice(0)) { try { db.close(); } catch {} } for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reclaude-storage-")); dirs.push(dir); return dir; }
export function historyFixture(root: string, id = randomUUID()) {
  const file = path.join(root, "projects", "-fixture-project", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const userId = randomUUID(), assistantId = randomUUID();
  const rows = [
    { type: "user", uuid: userId, parentUuid: null, sessionId: id, cwd: "/fixture/project", isSidechain: false, timestamp: new Date().toISOString(), message: { role: "user", content: "完整历史标记" } },
    { type: "assistant", uuid: assistantId, parentUuid: userId, sessionId: id, cwd: "/fixture/project", isSidechain: false, timestamp: new Date().toISOString(), message: { id: "message-fixture", type: "message", role: "assistant", model: "sonnet", content: [{ type: "text", text: "完整回答标记" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } }
  ];
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { file, id, assistantId, rows };
}
describe("global ReClaude session ledger", () => {
  it("shares all five slots across connections, retains them on restart, and expires on the rolling boundary", () => {
    const root = temp(); let now = 1_000_000;
    const first = new ClaudeSessionStorage(root, () => now), second = new ClaudeSessionStorage(root, () => now); databases.push(first, second);
    const ids = Array.from({length: 5}, () => randomUUID());
    ids.forEach((id, i) => (i % 2 ? first : second).reserve(id));
    first.reserve(ids[0]); expect(first.quota().used).toBe(5);
    expect(() => second.reserve(randomUUID())).toThrow("所有 Claude 账号");
    const reopened = new ClaudeSessionStorage(root, () => now); databases.push(reopened);
    expect(() => reopened.reserve(randomUUID())).toThrow("每小时");
    now += 1_500_000;
    expect(reopened.quota().retryAfterSeconds).toBe(2100);
    expect(() => reopened.reserve(randomUUID())).toThrow("还需等待 35 分 0 秒");
    now += 2_100_000; reopened.reserve(randomUUID()); expect(reopened.quota().used).toBe(1);
  });
  it("upgrades the old ledger without losing Claude reservations",()=>{
    const root=temp(),legacy=new DatabaseSync(path.join(root,"sessions.sqlite"));
    legacy.exec("CREATE TABLE creations(session_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL)");
    legacy.prepare("INSERT INTO creations VALUES (?,?)").run(randomUUID(),1000);legacy.close();
    const storage=new ClaudeSessionStorage(root,()=>2000);databases.push(storage);
    expect(storage.quota().used).toBe(1);storage.reserve(randomUUID());expect(storage.quota().used).toBe(2);
  });
});
describe("native history migration and offline branching", () => {
  it("rediscovers legacy and new binding directories, preserves complete history and omits credentials", () => {
    const home = temp(), old = path.join(home, ".claude"), target = path.join(home, ".rec/claude/accounts/42/config");
    fs.mkdirSync(target, {recursive:true});
    const source = historyFixture(old), original = fs.readFileSync(source.file);
    fs.writeFileSync(path.join(old, "settings.json"), '{"secret":"never-copy"}');
    const sidecar = path.join(path.dirname(source.file), source.id, "subagents"); fs.mkdirSync(sidecar, {recursive:true}); fs.writeFileSync(path.join(sidecar, "child.jsonl"), "child history\n");
    const staged = stageClaudeHistory(source.file, target, source.id, path.join(home,"archive"));
    expect(fs.readFileSync(staged)).toEqual(original); expect(fs.readFileSync(source.file)).toEqual(original);
    expect(fs.existsSync(path.join(target,"settings.json"))).toBe(false);
    expect(fs.readFileSync(path.join(path.dirname(staged),source.id,"subagents/child.jsonl"),"utf8")).toBe("child history\n");
    fs.appendFileSync(staged, '{"type":"summary","summary":"new metadata"}\n');
    expect(locateClaudeHistory(source.id, claudeConfigRoots(home), old)).toBe(staged);
    fs.appendFileSync(source.file, '{"different":"branch"}\n');
    expect(() => locateClaudeHistory(source.id, claudeConfigRoots(home), old)).toThrow("不同历史");
  });
  it("blocks network syscalls in the same guard used for SDK fork", () => {
    expect(() => execFileSync("/usr/bin/python3", [path.resolve("scripts/claude-offline-network-guard.py"), "/usr/bin/python3", "-c", "import socket; socket.socket()"], {stdio:"pipe"})).toThrow();
  });
  it("forks with the real SDK under kernel network denial, without modifying source messages", async () => {
    const root = temp(), fixture = historyFixture(root), original = fs.readFileSync(fixture.file);
    const fork = await offlineFork(fixture.id, root, "离线分支", fixture.assistantId);
    const file = locateClaudeHistory(fork, [root]); expect(file).toBeTruthy();
    const rows = fs.readFileSync(file!,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    const messages = rows.filter(row=>["user","assistant"].includes(row.type));
    expect(messages.map(row=>row.message)).toEqual(fixture.rows.map(row=>row.message));
    expect(messages[0].uuid).not.toBe(fixture.rows[0].uuid);
    expect(messages[1].parentUuid).toBe(messages[0].uuid);
    expect(messages.every(row=>row.sessionId===fork)).toBe(true);
    expect(fs.readFileSync(fixture.file)).toEqual(original);
  }, 20000);
});
