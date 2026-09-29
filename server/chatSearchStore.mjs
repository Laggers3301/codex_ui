import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldTurn } from 'node:timers/promises';

// Hex tokens keep punctuation, Chinese and surrogate pairs literal. A small
// unigram/bigram index handles short substrings; every candidate is verified
// against the original (lowercased) message, so tokenization cannot add hits.
export function shortTokens(text) {
  const chars = Array.from(text.toLowerCase());
  const tokens = new Set();
  for (let i = 0; i < chars.length; i++) {
    const first = chars[i].codePointAt(0).toString(16);
    tokens.add(`u${first}`);
    if (i + 1 < chars.length) tokens.add(`b${first}x${chars[i + 1].codePointAt(0).toString(16)}`);
  }
  return [...tokens].join(' ');
}

export class ChatSearchStore {
  constructor(sourcePath, searchPath) {
    this.source = new DatabaseSync(sourcePath, { readOnly: true });
    this.source.exec('PRAGMA busy_timeout=1000; PRAGMA cache_size=-8192');
    this.db = new DatabaseSync(searchPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA synchronous=NORMAL;
      PRAGMA cache_size=-8192;
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        record_id TEXT NOT NULL, turn_id TEXT NOT NULL, text TEXT NOT NULL, folded TEXT NOT NULL,
        UNIQUE(thread_id, ordinal)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(folded, tokenize='trigram');
      CREATE VIRTUAL TABLE IF NOT EXISTS short_fts USING fts5(tokens, tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY, inode INTEGER, file_path TEXT, source_size INTEGER,
        source_updated INTEGER, last_ordinal INTEGER, last_record_id TEXT,
        preview TEXT NOT NULL DEFAULT '', created_at REAL, updated_at REAL
      );
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('PRAGMA table_info(threads)').all().some(column => column.name === 'source_generation')) {
        this.db.exec('ALTER TABLE threads ADD COLUMN source_generation INTEGER NOT NULL DEFAULT 0');
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.syncing = false;
    this.ready = false;
    this.error = null;
    this.generation = 0;
  }

  clearThread(threadId) {
    for (const table of ['messages_fts', 'short_fts']) {
      this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT id FROM documents WHERE thread_id=?)`).run(threadId);
    }
    this.db.prepare('DELETE FROM documents WHERE thread_id=?').run(threadId);
    this.db.prepare('DELETE FROM threads WHERE thread_id=?').run(threadId);
  }

  async sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const files = this.source.prepare('SELECT * FROM thread_files ORDER BY updated_at DESC').all();
      const present = new Set(files.map(row => row.thread_id));
      for (const row of this.db.prepare('SELECT thread_id FROM threads').all()) {
        if (!present.has(row.thread_id)) this.clearThread(row.thread_id);
      }
      for (const file of files) {
        let previous = this.db.prepare('SELECT * FROM threads WHERE thread_id=?').get(file.thread_id);
        if (previous?.source_updated === file.updated_at && previous.source_size === file.indexed_offset
          && previous.source_generation === (file.index_generation ?? 0)) continue;
        const tail = previous?.last_ordinal ? this.source.prepare(
          'SELECT record_id FROM thread_records WHERE thread_id=? AND ordinal=?'
        ).get(file.thread_id, previous.last_ordinal) : null;
        if (previous && (previous.inode !== file.inode || previous.file_path !== file.file_path
          || previous.source_generation !== (file.index_generation ?? 0)
          || file.indexed_offset < previous.source_size
          || (file.indexed_offset === previous.source_size && file.updated_at !== previous.source_updated)
          || (previous.last_ordinal && tail?.record_id !== previous.last_record_id))) {
          this.clearThread(file.thread_id);
          previous = null;
        }
        let ordinal = previous?.last_ordinal ?? 0;
        let lastId = previous?.last_record_id ?? '';
        let preview = previous?.preview ?? '';
        let metadata = {};
        try { metadata = JSON.parse(file.metadata_line ?? '{}').payload ?? {}; } catch { /* legacy metadata */ }
        for (;;) {
          const rows = this.source.prepare(`SELECT ordinal, record_id, turn_id, kind, search_text FROM thread_records
            WHERE thread_id=? AND ordinal>? AND kind IN ('user','agent') ORDER BY ordinal LIMIT 64`).all(file.thread_id, ordinal);
          if (!rows.length) break;
          this.db.exec('BEGIN');
          try {
            for (const row of rows) {
              if (!preview && row.kind === 'user') preview = row.search_text.slice(0, 512);
              const folded = row.search_text.toLowerCase();
              const inserted = this.db.prepare(`INSERT OR IGNORE INTO documents(thread_id, ordinal, record_id, turn_id, text, folded)
                VALUES(?,?,?,?,?,?)`).run(file.thread_id, row.ordinal, row.record_id, row.turn_id, row.search_text, folded);
              if (inserted.changes) {
                this.db.prepare('INSERT INTO messages_fts(rowid,folded) VALUES(?,?)').run(inserted.lastInsertRowid, folded);
                this.db.prepare('INSERT INTO short_fts(rowid,tokens) VALUES(?,?)').run(inserted.lastInsertRowid, shortTokens(folded));
              }
              ordinal = row.ordinal;
              lastId = row.record_id;
            }
            this.db.exec('COMMIT');
          } catch (error) { this.db.exec('ROLLBACK'); throw error; }
          await yieldTurn();
        }
        this.db.prepare(`INSERT INTO threads(thread_id,inode,file_path,source_size,source_updated,last_ordinal,last_record_id,preview,created_at,updated_at,source_generation)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET
          inode=excluded.inode,file_path=excluded.file_path,source_size=excluded.source_size,source_updated=excluded.source_updated,
          last_ordinal=excluded.last_ordinal,last_record_id=excluded.last_record_id,preview=excluded.preview,
          created_at=excluded.created_at,updated_at=excluded.updated_at,source_generation=excluded.source_generation`).run(
          file.thread_id, file.inode, file.file_path, file.indexed_offset, file.updated_at, ordinal, lastId, preview,
          Date.parse(metadata.timestamp ?? '') / 1000 || file.mtime_ms / 1000, file.mtime_ms / 1000, file.index_generation ?? 0
        );
        this.generation++;
        await yieldTurn();
      }
      this.ready = true;
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.syncing = false; }
  }

  search(owners, rawQuery, { offset = 0, limit = 30 } = {}) {
    const query = String(rawQuery).trim().toLowerCase();
    if (!query || !owners.length) return { data: [], total: 0, nextOffset: null, pendingThreads: 0,
      indexing: !this.ready, generation: this.generation, indexError: this.error };
    const ids = JSON.stringify(owners.map(owner => owner.threadId));
    const short = Array.from(query).length < 3;
    const table = short ? 'short_fts' : 'messages_fts';
    const chars = Array.from(query);
    const expression = short ? (chars.length === 1 ? `u${chars[0].codePointAt(0).toString(16)}`
      : `b${chars[0].codePointAt(0).toString(16)}x${chars[1].codePointAt(0).toString(16)}`)
      : `"${query.replaceAll('"', '""')}"`;
    const rows = this.db.prepare(`WITH hits AS (
      SELECT d.id, ROW_NUMBER() OVER(PARTITION BY d.thread_id ORDER BY d.ordinal DESC) AS rank,
        COUNT(*) OVER(PARTITION BY d.thread_id) AS hit_count
      FROM ${table} f JOIN documents d ON d.id=f.rowid
      WHERE ${table} MATCH ? AND d.thread_id IN (SELECT value FROM json_each(?)) AND instr(d.folded,?)>0
    ) SELECT d.*, h.hit_count FROM hits h JOIN documents d ON d.id=h.id WHERE h.rank<=3`).all(expression, ids, query);
    const byThread = new Map();
    for (const row of rows) {
      if (!byThread.has(row.thread_id)) byThread.set(row.thread_id, []);
      byThread.get(row.thread_id).push(row);
    }
    const summaries = new Map(this.db.prepare('SELECT * FROM threads WHERE thread_id IN (SELECT value FROM json_each(?))').all(ids).map(row => [row.thread_id, row]));
    const results = [];
    for (const owner of owners) {
      const summary = summaries.get(owner.threadId);
      const name = owner.displayName || summary?.preview?.split('\n')[0]?.slice(0, 100) || null;
      const preview = summary?.preview ?? '';
      const titleMatch = `${name ?? ''}\n${preview}`.toLowerCase().includes(query);
      const hits = byThread.get(owner.threadId) ?? [];
      if (!titleMatch && !hits.length) continue;
      const matches = hits.map(row => {
        const at = row.folded.indexOf(query);
        return { threadId: owner.threadId, turnId: row.turn_id, itemId: row.record_id, ordinal: row.ordinal,
          query, snippet: row.text.slice(Math.max(0, at - 50), at + query.length + 110).replace(/\s+/g, ' '),
          cursor: Buffer.from(JSON.stringify({ v: 1, t: owner.threadId, o: row.ordinal + 1 })).toString('base64url') };
      });
      results.push({ id: owner.threadId, sessionId: owner.threadId, projectId: owner.projectId, name, preview,
        cwd: owner.rootPath, createdAt: summary?.created_at ?? Date.parse(owner.createdAt) / 1000,
        updatedAt: Math.max(summary?.updated_at ?? 0, Date.parse(owner.updatedAt) / 1000 || 0),
        turns: [], status: { type: 'idle' }, searchMatch: matches[0], searchMatches: matches,
        searchHitCount: hits[0]?.hit_count ?? 0, titleMatch });
    }
    results.sort((a,b) => Number(b.titleMatch)-Number(a.titleMatch) || b.updatedAt-a.updatedAt || a.id.localeCompare(b.id));
    return { data: results.slice(offset, offset + limit), total: results.length,
      nextOffset: offset + limit < results.length ? offset + limit : null,
      indexing: !this.ready, pendingThreads: owners.filter(owner => !summaries.has(owner.threadId)).length,
      generation: this.generation, indexError: this.error };
  }

  searchThreadHits(threadId, rawQuery, limit = 1000) {
    const query = String(rawQuery).trim().toLowerCase();
    if (!query) return { data: [], total: 0, indexing: !this.ready };
    const chars = Array.from(query);
    const short = chars.length < 3;
    const table = short ? 'short_fts' : 'messages_fts';
    const expression = short ? (chars.length === 1
      ? `u${chars[0].codePointAt(0).toString(16)}`
      : `b${chars[0].codePointAt(0).toString(16)}x${chars[1].codePointAt(0).toString(16)}`)
      : `"${query.replaceAll('"', '""')}"`;
    const rows = this.db.prepare(`SELECT d.record_id, d.turn_id, d.ordinal, d.text, d.folded,
      COUNT(*) OVER() AS hit_count FROM ${table} f JOIN documents d ON d.id=f.rowid
      WHERE ${table} MATCH ? AND d.thread_id=? AND instr(d.folded,?)>0
      ORDER BY d.ordinal ASC LIMIT ?`).all(expression, threadId, query, Math.min(2000, Math.max(1, limit)));
    return { data: rows.map(row => {
      const at = row.folded.indexOf(query);
      return { threadId, turnId: row.turn_id, itemId: row.record_id, ordinal: row.ordinal,
        query, snippet: row.text.slice(Math.max(0, at - 50), at + query.length + 110).replace(/\s+/g, ' '),
        cursor: Buffer.from(JSON.stringify({ v: 1, t: threadId, o: row.ordinal + 1 })).toString('base64url') };
    }), total: rows[0]?.hit_count ?? 0, indexing: !this.ready };
  }

  close() { this.db.close(); this.source.close(); }
}
