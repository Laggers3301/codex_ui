import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The isolated worker deliberately uses native ESM, without a TS loader.
// @ts-expect-error Native ESM worker module
import { ChatSearchStore } from "./chatSearchStore.mjs";

let dir: string, source: DatabaseSync, search: InstanceType<typeof ChatSearchStore>;
const owner = (threadId: string, displayName: string | null = null) => ({ threadId, displayName, projectId: 'p', rootPath: '/', createdAt: '2026-01-01', updatedAt: '2026-01-01' });
function thread(id: string, messages: string[], kind = 'user') {
  source.prepare('INSERT INTO thread_files VALUES(?,?,?,?,?,?,?,?)').run(id, '/'+id, 1, 100, 100, 1, 1000, '{}');
  for (const [index, text] of messages.entries()) source.prepare('INSERT INTO thread_records VALUES(?,?,?,?,?,?)').run(id, index+1, `${id}-${index}`, 'turn-'+id, kind, text);
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-search-test-'));
  source = new DatabaseSync(path.join(dir, 'source.sqlite'));
  source.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE thread_files(thread_id TEXT PRIMARY KEY,file_path TEXT,inode INTEGER,size INTEGER,indexed_offset INTEGER,updated_at INTEGER,mtime_ms REAL,metadata_line TEXT);
    CREATE TABLE thread_records(thread_id TEXT,ordinal INTEGER,record_id TEXT,turn_id TEXT,kind TEXT,search_text TEXT,PRIMARY KEY(thread_id,ordinal));`);
  search = new ChatSearchStore(path.join(dir, 'source.sqlite'), path.join(dir, 'search.sqlite'));
});
afterEach(() => { search.close(); source.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('message-only chat search', () => {
  it('groups before pagination; a large thread cannot crowd out other threads', async () => {
    thread('long', Array.from({length:120}, () => 'Markdown result'));
    thread('short', ['Markdown other']);
    await search.sync();
    const result = search.search([owner('long'),owner('short')], 'Markdown', { limit: 1 });
    expect(result.total).toBe(2);
    expect(result.nextOffset).toBe(1);
    const all = search.search([owner('long'),owner('short')], 'Markdown').data;
    expect(all.find((r: {id:string}) => r.id === 'long').searchHitCount).toBe(120);
    expect(all.find((r: {id:string}) => r.id === 'long').searchMatches).toHaveLength(3);
    const hits = search.searchThreadHits('long', 'Markdown');
    expect(hits.total).toBe(120);
    expect(hits.data).toHaveLength(120);
    expect(hits.data[0].itemId).toBe('long-0');
    expect(hits.data[119].itemId).toBe('long-119');
  });
  it('searches literal Chinese short terms, punctuation, emoji and case without LIKE wildcards', async () => {
    thread('a', ['渐变 中文 额度 100% enabled:false a_b 😀好 Markdown']);
    thread('b', ['1000 aXb 工具']);
    await search.sync();
    for (const q of ['渐','渐变','额度','%','_','😀','😀好','markdown','enabled:false']) {
      expect(search.search([owner('a'),owner('b')], q).data.map((r: {id:string}) => r.id)).toEqual(['a']);
      expect(search.searchThreadHits('a', q).data).toHaveLength(1);
    }
  });
  it('filters by server-owned thread IDs, excludes tools, and includes custom titles', async () => {
    thread('mine', ['plain']); thread('secret', ['secret']); thread('tool', ['secret'], 'tool');
    await search.sync();
    expect(search.search([owner('mine'), owner('tool')], 'secret').total).toBe(0);
    const titled = search.search([owner('mine','标题测试')], '标题').data[0];
    expect(titled.id).toBe('mine'); expect(titled.searchMatch).toBeUndefined();
    expect(search.search([], 'secret')).toMatchObject({ data: [], total: 0, nextOffset: null });
  });
  it('syncs append, rewrite, delete, and persisted restart without duplicate FTS rows', async () => {
    thread('a', ['old']); await search.sync();
    source.prepare('INSERT INTO thread_records VALUES(?,?,?,?,?,?)').run('a',2,'new','turn-a','agent','新增');
    source.exec("UPDATE thread_files SET indexed_offset=200,updated_at=2 WHERE thread_id='a'");
    await search.sync(); expect(search.search([owner('a')],'新增').total).toBe(1);
    search.close(); search = new ChatSearchStore(path.join(dir,'source.sqlite'),path.join(dir,'search.sqlite'));
    await search.sync(); expect(search.search([owner('a')],'新增').data[0].searchHitCount).toBe(1);
    source.exec("UPDATE thread_records SET search_text='替换',record_id='changed' WHERE thread_id='a' AND ordinal=2; UPDATE thread_files SET updated_at=3 WHERE thread_id='a'");
    await search.sync(); expect(search.search([owner('a')],'新增').total).toBe(0);
    expect(search.search([owner('a')],'替换').total).toBe(1);
    source.exec("DELETE FROM thread_files WHERE thread_id='a'");
    await search.sync(); expect(search.search([owner('a')],'替换').total).toBe(0);
  });
  it('invalidates an in-place rewrite even when message IDs and inode are unchanged', async () => {
    source.exec('ALTER TABLE thread_files ADD COLUMN index_generation INTEGER DEFAULT 0');
    source.prepare('INSERT INTO thread_files(thread_id,file_path,inode,size,indexed_offset,updated_at,mtime_ms,metadata_line) VALUES(?,?,?,?,?,?,?,?)').run('same', '/same', 1, 100, 100, 1, 1000, '{}');
    source.prepare('INSERT INTO thread_records VALUES(?,?,?,?,?,?)').run('same',1,'stable-id','turn','user','旧内容');
    await search.sync();
    source.exec("UPDATE thread_records SET search_text='重写的新内容'; UPDATE thread_files SET indexed_offset=200,updated_at=2,index_generation=1");
    await search.sync();
    expect(search.search([owner('same')],'旧内容').total).toBe(0);
    expect(search.search([owner('same')],'新内容').total).toBe(1);
  });
});
