import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSessionStorage, claudeConfigRoots, locateClaudeHistory, stageClaudeHistory, type ClaudeConversation } from "./claudeSessionStorage.js";
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
  it("pages by bytes before reading bodies and preserves every original turn", () => {
    const db = new ClaudeSessionStorage(temp(), () => 1000); databases.push(db);
    for (let i = 0; i < 5; i++) db.saveTurn("large", {id:`large-${i}`, text:"中".repeat(700_000)});
    expect(db.turns("large", 50).map(turn => turn.id)).toEqual(["large-2", "large-3", "large-4"]);
    expect(db.turns("large", 50, 3).map(turn => turn.id)).toEqual(["large-0", "large-1"]);
    expect(db.turnCount("large")).toBe(5);
    db.saveTurn("oversize", {id:"oversize-turn", status:"inProgress", text:"x".repeat(9 * 1024 ** 2)});
    expect(() => db.turns("oversize")).toThrow(/安全读取上限/);
    expect(() => db.turn("oversize-turn")).toThrow(/安全内存读取上限/);
    db.interruptUnfinishedTurns();
    expect(db.db.prepare("SELECT json_extract(body, '$.status') AS status, length(CAST(body AS BLOB)) AS bytes FROM turns WHERE id='oversize-turn'").get())
      .toMatchObject({status:"interrupted", bytes:expect.any(Number)});
    expect(db.turnCount("oversize")).toBe(1);
  });
  it("keeps native mappings and lineage atomic and retains a failed migration journal for recovery",()=>{
    const root=temp(),storage=new ClaudeSessionStorage(root);databases.push(storage);
    const before:ClaudeConversation={id:randomUUID(),userId:"alice",projectId:"project",cwd:"/fixture/alice",name:"history",model:"reclaude-sonnet@1",orgId:"1",accountKey:"old-account",configRoot:"/fixture/old",nativeSessionId:randomUUID(),initialized:true,archived:false,createdAt:1,updatedAt:1};
    storage.save(before);
    expect(()=>storage.save({...before,id:randomUUID()})).toThrow("属于另一条");
    expect(storage.list()).toHaveLength(1);
    const after={...before,nativeSessionId:randomUUID(),configRoot:"/fixture/new",accountKey:"new-account"};
    const migration=storage.beginBindingMigration(before,after);
    storage.db.exec("CREATE TRIGGER fail_lineage BEFORE INSERT ON lineage BEGIN SELECT RAISE(ABORT,'fixture interruption'); END");
    expect(()=>storage.finishBindingMigration(migration)).toThrow("fixture interruption");
    expect(storage.get(before.id)).toEqual(before);expect(storage.pendingBindingMigrations()).toHaveLength(1);
    storage.db.exec("DROP TRIGGER fail_lineage");storage.finishBindingMigration(migration);
    expect(storage.get(before.id)).toEqual(after);expect(storage.pendingBindingMigrations()).toEqual([]);
    expect((storage.db.prepare("SELECT thread_id FROM lineage WHERE native_id=?").get(after.nativeSessionId) as any).thread_id).toBe(before.id);
    expect(()=>storage.beginBindingMigration(after,{...after,userId:"bob"})).toThrow("不能更改用户");
  });
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
