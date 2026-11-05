import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "./appErrors.js";
import { remainingTime } from "../shared/reclaudeUsage.js";
import { HistoryMemoryLimitError, MAX_FULL_HISTORY_BYTES } from "./rolloutStorage.js";

const HOUR = 3_600_000;
const LIMIT = 5;
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface ClaudeConversation {
  id: string; userId: string; projectId: string; cwd: string; name: string; model: string;
  orgId: string; accountKey: string; configRoot: string; nativeSessionId: string;
  parentThreadId?: string; parentSessionId?: string; resumeSessionId?: string;
  initialized: boolean; archived: boolean; createdAt: number; updatedAt: number;
  historyArchive?: string;
  inheritedTurnCount?: number;
  collaborationMode?: "plan" | "default";
}

/** One database for every bound user/account/organization, including forks.
 * A failed or uncertain creation keeps its slot: restarting cannot reset the
 * limit or turn an ambiguous attempt into an uncounted new upstream session. */
export class ClaudeSessionStorage {
  readonly db: DatabaseSync;
  constructor(readonly directory: string, private now = Date.now) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "sessions.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS creations (session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, runtime TEXT NOT NULL DEFAULT 'claude-code');
      CREATE INDEX IF NOT EXISTS creations_time ON creations(created_at);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS turns (thread_id TEXT NOT NULL, id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turns_thread_time ON turns(thread_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS lineage (native_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL);
    `);
    const columns=this.db.prepare("PRAGMA table_info(creations)").all() as Array<{name:string}>;
    if(!columns.some(column=>column.name==="runtime"))this.db.exec("ALTER TABLE creations ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude-code'");
  }
  close() { this.db.close(); }
  quota() {
    const now = this.now();
    const row = this.db.prepare("SELECT COUNT(*) AS used, MIN(created_at) AS oldest FROM creations WHERE runtime='claude-code' AND created_at > ?").get(now - HOUR) as { used: number; oldest: number | null };
    const retryAfterSeconds = row.used >= LIMIT && row.oldest !== null ? Math.max(0, Math.ceil((row.oldest + HOUR - now) / 1000)) : 0;
    return { limit: LIMIT, windowSeconds: HOUR / 1000, used: row.used, remaining: Math.max(0, LIMIT - row.used), retryAt: row.used >= LIMIT && row.oldest !== null ? new Date(row.oldest + HOUR).toISOString() : null, retryAfterSeconds };
  }
  assertCapacity(sessionId?: string): void {
    if (sessionId && this.db.prepare("SELECT 1 FROM creations WHERE session_id=?").get(sessionId)) return;
    const quota = this.quota();
    if (!quota.remaining) throw new AppError("claude_session_rate_limit", `所有 Claude 账号合计每小时最多 ${LIMIT} 次 Claude 会话新建、fork 或迁入，当前已用 ${quota.used}/${LIMIT}。还需等待 ${remainingTime(quota.retryAfterSeconds)}（${new Date(quota.retryAt!).toLocaleString("zh-CN", { timeZone: "Asia/Singapore", hour12: false })}，UTC+8）后重试；Codex 会话新建、fork、迁入 Codex 以及已有会话续聊不占此额度。`);
  }
  reserve(sessionId: string): void {
    if (!sessionIdPattern.test(sessionId)) throw new Error("Invalid native Claude session id.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT 1 FROM creations WHERE session_id=?").get(sessionId)) {
        this.assertCapacity();
        this.db.prepare("INSERT INTO creations(session_id,created_at,runtime) VALUES (?,?,'claude-code')").run(sessionId, this.now());
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get(id: string): ClaudeConversation | null {
    const row = this.db.prepare("SELECT body FROM conversations WHERE id=?").get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  save(row: ClaudeConversation) {
    this.db.prepare("INSERT INTO conversations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(row.id, JSON.stringify(row));
    this.db.prepare("INSERT INTO lineage VALUES (?,?,?) ON CONFLICT(native_id) DO UPDATE SET body=excluded.body").run(row.nativeSessionId, row.id, JSON.stringify(row));
  }
  list(userId?: string, projectId?: string): ClaudeConversation[] {
    return (this.db.prepare("SELECT body FROM conversations").all() as Array<{ body: string }>).map(row => JSON.parse(row.body) as ClaudeConversation)
      .filter(row => (!userId || row.userId === userId) && (!projectId || row.projectId === projectId));
  }
  saveTurn(threadId: string, turn: Record<string, unknown>) {
    this.db.prepare("INSERT INTO turns VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(threadId, String(turn.id), this.now(), JSON.stringify(turn));
  }
  interruptUnfinishedTurns() {
    // Repair restart metadata in SQLite without loading possibly huge bodies into JS.
    this.db.prepare("UPDATE turns SET body=json_set(body, '$.status', 'interrupted', '$.error', json(?)) WHERE json_extract(body, '$.status')='inProgress'")
      .run(JSON.stringify({ message: "服务重启，本轮结果尚未确认。请检查记录后继续。" }));
  }
  turns(threadId: string, limit = 50, before = 0, maxBytes = MAX_FULL_HISTORY_BYTES): Record<string, unknown>[] {
    // Size metadata first: never fetch all bodies and truncate after parsing.
    const rows = this.db.prepare("SELECT id, length(CAST(body AS BLOB)) AS bytes FROM turns WHERE thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(threadId, Math.min(100, Math.max(1, limit)), Math.max(0, before)) as Array<{ id: string; bytes: number }>;
    const selected: string[] = [];
    let bytes = 0;
    for (const row of rows) {
      if (bytes + row.bytes > maxBytes) {
        if (!selected.length && maxBytes === MAX_FULL_HISTORY_BYTES && row.bytes > MAX_FULL_HISTORY_BYTES) throw new HistoryMemoryLimitError("单轮 Claude 历史超过安全读取上限，原始历史未修改；请从原生历史归档查看。");
        break;
      }
      selected.push(row.id); bytes += row.bytes;
    }
    const read = this.db.prepare("SELECT body FROM turns WHERE id=?");
    return selected.reverse().map(id => JSON.parse((read.get(id) as { body: string }).body));
  }
  turnCount(threadId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM turns WHERE thread_id=?").get(threadId) as { n: number }).n;
  }
  turn(id: string): Record<string, unknown> | null {
    const size = this.db.prepare("SELECT length(CAST(body AS BLOB)) AS bytes FROM turns WHERE id=?").get(id) as { bytes: number } | undefined;
    if (!size) return null;
    if (size.bytes > MAX_FULL_HISTORY_BYTES) throw new HistoryMemoryLimitError();
    const row = this.db.prepare("SELECT body FROM turns WHERE id=?").get(id) as {body: string} | undefined;
    return row ? JSON.parse(row.body) : null;
  }
  updateQueued(threadId: string, id: string, input: unknown) {
    const row = this.queued(threadId).find(item => item.id === id);
    if (!row) throw new Error("排队消息不存在。");
    this.db.prepare("UPDATE queue SET body=? WHERE id=? AND thread_id=?").run(JSON.stringify({...row, input}), id, threadId);
  }
  enqueue(threadId: string, body: Record<string, unknown>) {
    const item = { ...body, id: randomUUID(), status: "queued", createdAt: new Date(this.now()).toISOString() };
    this.db.prepare("INSERT INTO queue VALUES (?,?,?,?)").run(item.id, threadId, this.now(), JSON.stringify(item));
    return item;
  }
  queued(threadId: string): Record<string, unknown>[] {
    return (this.db.prepare("SELECT body FROM queue WHERE thread_id=? ORDER BY created_at,rowid").all(threadId) as Array<{ body: string }>).map(row => JSON.parse(row.body));
  }
  removeQueued(threadId: string, id: string) { this.db.prepare("DELETE FROM queue WHERE thread_id=? AND id=?").run(threadId, id); }
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function claudeConfigRoots(home: string): string[] {
  const roots: string[] = [];
  const legacy = path.join(home, ".claude");
  if (fs.existsSync(legacy)) roots.push(legacy);
  const accounts = path.join(home, ".rec", "claude", "accounts");
  if (fs.existsSync(accounts)) for (const entry of fs.readdirSync(accounts, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(accounts, entry.name, "config");
    if (fs.existsSync(root) && inside(accounts, root)) roots.push(root);
  }
  return [...new Set(roots.map(root => fs.realpathSync(root)))];
}

/** Resolve by native session identity on every use; a recorded absolute path
 * is only a hint. Never scan credential files or select a different session. */
export function locateClaudeHistory(sessionId: string, roots: string[], preferredRoot?: string): string | null {
  if (!sessionIdPattern.test(sessionId)) throw new Error("Invalid native Claude session id.");
  const matches: string[] = [];
  for (const root of [...new Set([...(preferredRoot ? [preferredRoot] : []), ...roots])]) {
    const projects = path.join(root, "projects");
    if (!fs.existsSync(projects)) continue;
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(projects, entry.name, `${sessionId}.jsonl`);
      if (fs.existsSync(file) && inside(root, file)) matches.push(fs.realpathSync(file));
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length <= 1) return unique[0] ?? null;
  // Copies left behind by a migration are safe only when they agree. Do not
  // silently choose an older/shorter history by path order or timestamp.
  const digests = new Set(unique.map(file => hashFile(file)));
  if (digests.size > 1) {
    const newest = [...unique].sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
    if (unique.every(file => isFilePrefix(file, newest))) return newest;
    throw new AppError("claude_history_conflict", "多个目录中存在同一会话的不同历史，已停止自动切换以保留全部记录。");
  }
  return unique[0];
}
function isFilePrefix(short: string, full: string): boolean {
  const left = fs.openSync(short, "r"), right = fs.openSync(full, "r");
  const a = Buffer.alloc(256 * 1024), b = Buffer.alloc(a.length);
  try {
    let n: number;
    while ((n = fs.readSync(left, a, 0, a.length, null))) {
      if (fs.readSync(right, b, 0, n, null) !== n || !a.subarray(0, n).equals(b.subarray(0, n))) return false;
    }
    return true;
  } finally { fs.closeSync(left); fs.closeSync(right); }
}
export function hashClaudeHistory(file: string): string { return hashFile(file); }
function hashFile(file: string): string {
  const hash = createHash("sha256"); const fd = fs.openSync(file, "r"); const buffer = Buffer.alloc(256 * 1024);
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

/** Copy complete native history and its per-session sidecars, never settings,
 * oauth credentials, device keys, or account configuration. The isolated
 * filesystem-only SDK worker performs the actual branching afterwards. */
export function stageClaudeHistory(source: string, targetRoot: string, sessionId: string, archiveDirectory: string): string {
  if (!sessionIdPattern.test(sessionId) || path.basename(source) !== `${sessionId}.jsonl`) throw new Error("History/session identity mismatch.");
  const before = fs.statSync(source);
  const project = path.basename(path.dirname(source));
  const target = path.join(targetRoot, "projects", project, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!inside(targetRoot, path.dirname(target))) throw new Error("Claude history destination escaped its configuration root.");
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const digest = hashFile(source);
  const archive = path.join(archiveDirectory, sessionId, digest, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(archive)) fs.copyFileSync(source, archive, fs.constants.COPYFILE_EXCL);
  if (hashFile(archive) !== digest) throw new Error("Claude history archive checksum mismatch.");
  fs.chmodSync(archive, 0o600);
  if (fs.existsSync(target)) {
    if (fs.realpathSync(target) !== fs.realpathSync(source) && hashFile(target) !== digest) throw new AppError("claude_history_conflict", "目标目录已存在不同的会话历史，原文件未覆盖。");
  } else { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600); }
  const after = fs.statSync(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || hashFile(target) !== digest) throw new AppError("claude_history_busy", "源会话历史正在变化，暂不切换账号。");
  const sidecars = path.join(path.dirname(source), sessionId);
  if (fs.existsSync(sidecars)) {
    const destination = path.join(path.dirname(target), sessionId);
    {
      // Reject symlinks rather than copying unrelated paths out of a session.
      const check = (dir: string): void => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { if (entry.isSymbolicLink()) throw new Error("Session sidecars contain a symbolic link."); if (entry.isDirectory()) check(path.join(dir, entry.name)); } };
      check(sidecars);
      const merge = (src: string, dst: string): void => {
        fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const from = path.join(src, entry.name), to = path.join(dst, entry.name);
          if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) throw new Error("Session destination contains a symbolic link.");
          if (entry.isDirectory()) merge(from, to);
          else if (!fs.existsSync(to)) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
          else if (hashFile(from) !== hashFile(to)) throw new AppError("claude_history_conflict", "会话附件历史存在冲突，未覆盖任何原文件。");
        }
      };
      if (path.resolve(sidecars) !== path.resolve(destination)) merge(sidecars, destination);
      merge(sidecars, path.join(path.dirname(archive), sessionId));
    }
  }
  return target;
}
