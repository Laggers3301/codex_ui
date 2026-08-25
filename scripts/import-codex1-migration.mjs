import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const [sourceWebPath, sourceStatePath, targetWebPath, poolStatePath] = process.argv.slice(2);
if (!sourceWebPath || !sourceStatePath || !targetWebPath || !poolStatePath) {
  throw new Error("usage: import-codex1-migration.mjs <source-web> <source-state> <target-web> <pool-state>");
}

const accountId = "260707";
const projectName = "codex1 迁移会话";
const projectRootBase = process.env.CODEX1_PROJECT_ROOT_BASE || "/home/ls/codex_zerotier_remote/users";
const aliases = new Map([
  ["jiaming", "wjm"],
  ["jiangyuhua", "jyh"],
  ["wangxuran", "wxr"],
  ["wuming", "wm"],
  ["吴明", "wm"],
  ["xujiayu", "xjy"],
  ["x'j'y", "xjy"],
]);

function canonicalUserId(userId) {
  const clean = String(userId ?? "").trim();
  return aliases.get(clean) ?? clean;
}

function safeUserDirectory(userId) {
  const clean = userId.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[_ .-]+|[_ .-]+$/g, "");
  return clean || `user-${Buffer.from(userId).toString("hex").slice(0, 12)}`;
}

function cleanName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 512) : "";
}

const sourceWeb = new DatabaseSync(sourceWebPath, { readOnly: true });
const sourceState = new DatabaseSync(sourceStatePath, { readOnly: true });
const target = new DatabaseSync(targetWebPath);

const targetOwnerColumns = target.prepare("PRAGMA table_info(thread_owners)").all().map((row) => String(row.name));
if (!targetOwnerColumns.includes("display_name")) {
  target.exec("ALTER TABLE thread_owners ADD COLUMN display_name TEXT");
}

const sourceOwners = sourceWeb.prepare(`
  SELECT thread_id, user_id, created_at, updated_at
  FROM thread_owners
  ORDER BY user_id, created_at, thread_id
`).all();
const sourceUnused = new Set(sourceWeb.prepare("SELECT thread_id FROM unuse").all().map((row) => String(row.thread_id)));
const sourcePresentation = new Map(sourceWeb.prepare(`
  SELECT thread_id, pinned, manual_order, display_name
  FROM thread_presentations
`).all().map((row) => [String(row.thread_id), row]));
const sourceThreads = new Map(sourceState.prepare(`
  SELECT id, name, title, created_at, created_at_ms
  FROM threads
`).all().map((row) => [String(row.id), row]));

const records = sourceOwners.map((owner) => {
  const threadId = String(owner.thread_id);
  const state = sourceThreads.get(threadId);
  const presentation = sourcePresentation.get(threadId);
  return {
    threadId,
    userId: canonicalUserId(owner.user_id),
    sourceUserId: String(owner.user_id),
    createdAt: String(owner.created_at || new Date().toISOString()),
    updatedAt: String(owner.updated_at || owner.created_at || new Date().toISOString()),
    pinned: Number(presentation?.pinned ?? 0) ? 1 : 0,
    manualOrder: Number.isFinite(Number(presentation?.manual_order)) ? Number(presentation.manual_order) : null,
    originalName: cleanName(presentation?.display_name) || cleanName(state?.name) || cleanName(state?.title),
    deleted: sourceUnused.has(threadId),
  };
});

const nameCounts = new Map();
for (const record of records) {
  if (!record.originalName) continue;
  const key = `${record.userId}\u0000${record.originalName.toLocaleLowerCase()}`;
  nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
}
for (const record of records) {
  if (!record.originalName) {
    record.displayName = null;
    continue;
  }
  const key = `${record.userId}\u0000${record.originalName.toLocaleLowerCase()}`;
  record.displayName = nameCounts.get(key) > 1
    ? `${record.originalName} · ${accountId} · ${record.threadId.slice(0, 8)}-${record.threadId.slice(-6)}`
    : record.originalName;
}

const now = new Date().toISOString();
const projectIds = new Map();
const importedByUser = new Map();
const conflicts = [];

target.exec("BEGIN IMMEDIATE");
try {
  const ensureUser = target.prepare(`
    INSERT INTO users (id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
  `);
  const findProject = target.prepare("SELECT id FROM projects WHERE user_id = ? AND root_path = ?");
  const createProject = target.prepare(`
    INSERT INTO projects (
      id, user_id, name, root_path, default_model, default_reasoning_effort,
      default_sandbox, default_approval_policy, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'gpt-5.5', 'xhigh', 'danger-full-access', 'never', ?, ?)
  `);
  const findOwner = target.prepare("SELECT user_id FROM thread_owners WHERE thread_id = ?");
  const insertOwner = target.prepare(`
    INSERT INTO thread_owners (
      thread_id, user_id, project_id, root_path, is_pinned, manual_order,
      model_override, reasoning_effort_override, display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      project_id = excluded.project_id,
      root_path = excluded.root_path,
      is_pinned = excluded.is_pinned,
      manual_order = excluded.manual_order,
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
    WHERE thread_owners.user_id = excluded.user_id
  `);
  const insertUnused = target.prepare(`
    INSERT INTO unuse (thread_id, user_id, project_id, root_path, deleted_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(thread_id, user_id) DO UPDATE SET
      project_id = excluded.project_id,
      root_path = excluded.root_path,
      deleted_at = excluded.deleted_at
  `);
  const restoreVisible = target.prepare("DELETE FROM unuse WHERE thread_id = ? AND user_id = ?");

  for (const record of records) {
    let projectId = projectIds.get(record.userId);
    if (!projectId) {
      const projectRoot = path.join(projectRootBase, safeUserDirectory(record.userId), "codex1-migrated");
      fs.mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
      ensureUser.run(record.userId, record.userId, now, now);
      projectId = findProject.get(record.userId, projectRoot)?.id;
      if (!projectId) {
        projectId = randomUUID();
        createProject.run(projectId, record.userId, projectName, projectRoot, now, now);
      } else {
        target.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(projectName, now, projectId);
      }
      projectIds.set(record.userId, String(projectId));
    }

    const existing = findOwner.get(record.threadId);
    if (existing && String(existing.user_id) !== record.userId) {
      conflicts.push({ threadId: record.threadId, existingUserId: String(existing.user_id), sourceUserId: record.sourceUserId });
      continue;
    }

    const projectRoot = path.join(projectRootBase, safeUserDirectory(record.userId), "codex1-migrated");
    insertOwner.run(
      record.threadId,
      record.userId,
      projectId,
      projectRoot,
      record.pinned,
      record.manualOrder,
      record.displayName,
      record.createdAt,
      record.updatedAt,
    );
    if (record.deleted) insertUnused.run(record.threadId, record.userId, projectId, projectRoot, record.updatedAt);
    else restoreVisible.run(record.threadId, record.userId);

    const bucket = importedByUser.get(record.userId) ?? { total: 0, visible: 0, deleted: 0 };
    bucket.total += 1;
    if (record.deleted) bucket.deleted += 1;
    else bucket.visible += 1;
    importedByUser.set(record.userId, bucket);
  }
  target.exec("COMMIT");
} catch (error) {
  target.exec("ROLLBACK");
  throw error;
}

const poolState = JSON.parse(fs.readFileSync(poolStatePath, "utf8"));
poolState.threadAccounts = poolState.threadAccounts && typeof poolState.threadAccounts === "object" ? poolState.threadAccounts : {};
for (const record of records) poolState.threadAccounts[record.threadId] = accountId;
const temporaryPoolState = `${poolStatePath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryPoolState, `${JSON.stringify(poolState, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryPoolState, poolStatePath);

console.log(JSON.stringify({
  projectName,
  sourceOwners: sourceOwners.length,
  importedOwners: [...importedByUser.values()].reduce((sum, bucket) => sum + bucket.total, 0),
  conflicts,
  users: Object.fromEntries([...importedByUser.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
}, null, 2));

sourceWeb.close();
sourceState.close();
target.close();
