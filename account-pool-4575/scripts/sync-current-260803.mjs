import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const [sourceHome, targetHome, sourceWebPath, targetWebPath, poolStatePath] = process.argv.slice(2);
if (!sourceHome || !targetHome || !sourceWebPath || !targetWebPath || !poolStatePath) {
  throw new Error("usage: sync-current-260803.mjs <source-home> <target-home> <source-web> <target-web> <pool-state>");
}

const accountId = "260803";
const migrationProjectName = "codex1 迁移会话";
const usersRoot = path.resolve(process.env.CODEX_WEB_USERS_ROOT || "/home/ls/codex_zerotier_remote/users");
const aliases = new Map([
  ["jiaming", "wjm"],
  ["jiangyuhua", "jyh"],
  ["wangxuran", "wxr"],
  ["wuming", "wm"],
  ["吴明", "wm"],
  ["xujiayu", "xjy"],
  ["x'j'y", "xjy"],
]);

function canonicalUserId(value) {
  const clean = String(value ?? "").trim();
  return aliases.get(clean) ?? clean;
}

function canonicalProjectForUser(userId, sourceProject) {
  if (String(sourceProject.name ?? "").trim() !== migrationProjectName) {
    return {
      name: String(sourceProject.name),
      rootPath: String(sourceProject.root_path),
    };
  }
  return {
    name: migrationProjectName,
    rootPath: path.join(usersRoot, userId, "codex1-migrated"),
  };
}

function deterministicCloneId(threadId) {
  const bytes = Buffer.from(createHash("sha256").update(`codex-260803-current:${threadId}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function pathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null;
}

function replaceBufferSameLength(buffer, from, to) {
  if (from.equals(to)) return buffer;
  const result = Buffer.from(buffer);
  let offset = 0;
  while (offset <= result.length - from.length) {
    const index = result.indexOf(from, offset);
    if (index < 0) break;
    to.copy(result, index);
    offset = index + from.length;
  }
  return result;
}

function syncSessionFile(sourcePath, destinationPath, sourceId, destinationId, previousSync) {
  const sourceStat = fs.statSync(sourcePath);
  const destinationStat = fs.statSync(destinationPath, { throwIfNoEntry: false });
  if (previousSync && destinationStat) {
    const destinationChanged = destinationStat.size !== previousSync.destinationSize
      || Math.abs(destinationStat.mtimeMs - previousSync.destinationMtimeMs) > 2;
    const sourceChanged = sourceStat.size !== previousSync.sourceSize
      || Math.abs(sourceStat.mtimeMs - previousSync.sourceMtimeMs) > 2;
    if (destinationChanged) {
      return { result: "destination-newer", sourceStat, destinationStat };
    }
    if (!sourceChanged) {
      return { result: "unchanged", sourceStat, destinationStat };
    }
  }
  if (destinationStat && destinationStat.size === sourceStat.size && destinationStat.mtimeMs >= sourceStat.mtimeMs) {
    return { result: "unchanged", sourceStat, destinationStat };
  }
  if (destinationStat && destinationStat.size > sourceStat.size) {
    return { result: "destination-newer", sourceStat, destinationStat };
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const sourceFd = fs.openSync(sourcePath, "r");
  const destinationFd = fs.openSync(destinationPath, destinationStat ? "r+" : "w", 0o600);
  const from = Buffer.from(sourceId, "utf8");
  const to = Buffer.from(destinationId, "utf8");
  if (from.length !== to.length) throw new Error("thread IDs must have the same byte length");
  const blockSize = 4 * 1024 * 1024;
  const overlap = from.length - 1;
  let position = destinationStat ? Math.max(0, destinationStat.size - overlap) : 0;
  try {
    while (position < sourceStat.size) {
      const writeLength = Math.min(blockSize, sourceStat.size - position);
      const readLength = Math.min(writeLength + overlap, sourceStat.size - position);
      const buffer = Buffer.allocUnsafe(readLength);
      const bytesRead = fs.readSync(sourceFd, buffer, 0, readLength, position);
      const replaced = replaceBufferSameLength(buffer.subarray(0, bytesRead), from, to);
      fs.writeSync(destinationFd, replaced, 0, Math.min(writeLength, replaced.length), position);
      position += writeLength;
    }
    fs.ftruncateSync(destinationFd, sourceStat.size);
  } finally {
    fs.closeSync(sourceFd);
    fs.closeSync(destinationFd);
  }
  fs.chmodSync(destinationPath, 0o600);
  fs.utimesSync(destinationPath, sourceStat.atime, sourceStat.mtime);
  return {
    result: destinationStat ? "updated" : "copied",
    sourceStat,
    destinationStat: fs.statSync(destinationPath),
  };
}

function listJsonlFiles(root) {
  const result = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(entryPath);
    }
  }
  return result;
}

function threadIdFromSessionPath(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] ?? null;
}

function upsertRows(target, table, rows, mapRow = (row) => row) {
  if (!rows.length) return 0;
  const targetColumns = new Set(target.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => String(row.name)));
  const columns = Object.keys(rows[0]).filter((column) => targetColumns.has(column));
  if (!columns.length) return 0;
  const primaryKeys = target.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
  const quotedColumns = columns.map(quoteIdentifier).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const updateColumns = columns.filter((column) => !primaryKeys.includes(column));
  const conflict = primaryKeys.length
    ? ` ON CONFLICT (${primaryKeys.map(quoteIdentifier).join(", ")}) DO UPDATE SET ${updateColumns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(", ")}`
    : "";
  const statement = target.prepare(`INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${placeholders})${conflict}`);
  let count = 0;
  for (const original of rows) {
    const row = mapRow({ ...original });
    statement.run(...columns.map((column) => row[column] ?? null));
    count += 1;
  }
  return count;
}

const sourceState = new DatabaseSync(path.join(sourceHome, "state_5.sqlite"), { readOnly: true });
const targetState = new DatabaseSync(path.join(targetHome, "state_5.sqlite"));
// Title metadata is synchronized in both directions.  This intentionally is
// the only writable part of the source web database: account/session state
// remains owned by its own app-server and is never shared between deployments.
const sourceWeb = new DatabaseSync(sourceWebPath);
const targetWeb = new DatabaseSync(targetWebPath);

function ensureThreadTitleColumns(database) {
  const columns = new Set(database.prepare("PRAGMA table_info(thread_owners)").all().map((row) => String(row.name)));
  if (!columns.has("display_name")) database.exec("ALTER TABLE thread_owners ADD COLUMN display_name TEXT");
  if (!columns.has("display_name_updated_at")) database.exec("ALTER TABLE thread_owners ADD COLUMN display_name_updated_at TEXT");
  // Titles written before title timestamps existed were already the visible
  // choice in this UI. Preserve them once, rather than letting the next import
  // blindly replace them with a first-prompt preview.
  database.exec(`
    UPDATE thread_owners
    SET display_name_updated_at = updated_at
    WHERE display_name IS NOT NULL AND trim(display_name) <> ''
      AND (display_name_updated_at IS NULL OR display_name_updated_at = '')
  `);
}

ensureThreadTitleColumns(sourceWeb);
ensureThreadTitleColumns(targetWeb);

// The web backend and this 15-second mirror intentionally share targetWeb.
// WAL lets the backend continue serving reads while the mirror commits, and
// busy_timeout prevents either writer from surfacing a transient lock as a
// user-visible error. Apply the same policy to the account state database,
// which is also shared with the account's running app-server.
for (const database of [sourceWeb, targetState, targetWeb]) {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
}

const sourceOwnerRows = sourceWeb.prepare("SELECT * FROM thread_owners").all();
const targetMigratedIds = new Set(targetWeb.prepare(`
  SELECT thread_id FROM thread_owners WHERE root_path LIKE '%/codex1-migrated'
`).all().map((row) => String(row.thread_id)));
const sourceOwnerIds = new Set(sourceOwnerRows.map((row) => String(row.thread_id)));
const overlappingIds = new Set([...sourceOwnerIds].filter((threadId) => targetMigratedIds.has(threadId)));
const cloneIds = new Map([...overlappingIds].map((threadId) => [threadId, deterministicCloneId(threadId)]));
const destinationIdFor = (threadId) => cloneIds.get(String(threadId)) ?? String(threadId);

const sourceSessionsRoot = path.join(sourceHome, "sessions");
const targetSessionsRoot = path.join(targetHome, "sessions");
const sourceThreadRows = sourceState.prepare("SELECT * FROM threads").all();
const sourceThreadsById = new Map(sourceThreadRows.map((row) => [String(row.id), row]));
const fileResults = { copied: 0, updated: 0, unchanged: 0, destinationNewer: 0, missing: 0 };
const destinationPaths = new Map();
const processedSourcePaths = new Set();
const protectedThreadIds = new Set();
const manifestPath = process.env.CODEX_260803_SYNC_MANIFEST
  || path.join(path.dirname(poolStatePath), "260803-live-sync-manifest.json");
const manifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  : { version: 1, files: {} };
manifest.files = manifest.files && typeof manifest.files === "object" ? manifest.files : {};

function recordSyncResult(sourceId, syncResult) {
  if (syncResult.result === "destination-newer") {
    fileResults.destinationNewer += 1;
    protectedThreadIds.add(sourceId);
    return;
  }
  fileResults[syncResult.result] += 1;
  manifest.files[sourceId] = {
    sourceSize: syncResult.sourceStat.size,
    sourceMtimeMs: syncResult.sourceStat.mtimeMs,
    destinationSize: syncResult.destinationStat.size,
    destinationMtimeMs: syncResult.destinationStat.mtimeMs,
  };
}

for (const row of sourceThreadRows) {
  const sourceId = String(row.id);
  const destinationId = destinationIdFor(sourceId);
  const relative = pathInside(String(row.rollout_path ?? ""), sourceSessionsRoot);
  if (!relative || !fs.existsSync(String(row.rollout_path))) {
    fileResults.missing += 1;
    continue;
  }
  const destinationRelative = sourceId === destinationId ? relative : relative.replaceAll(sourceId, destinationId);
  const destinationPath = path.join(targetSessionsRoot, destinationRelative);
  const result = syncSessionFile(String(row.rollout_path), destinationPath, sourceId, destinationId, manifest.files[sourceId]);
  recordSyncResult(sourceId, result);
  destinationPaths.set(sourceId, destinationPath);
  processedSourcePaths.add(path.resolve(String(row.rollout_path)));
}

for (const sourcePath of listJsonlFiles(sourceSessionsRoot)) {
  if (processedSourcePaths.has(path.resolve(sourcePath))) continue;
  const sourceId = threadIdFromSessionPath(sourcePath);
  if (!sourceId) {
    fileResults.missing += 1;
    continue;
  }
  const destinationId = destinationIdFor(sourceId);
  const relative = path.relative(sourceSessionsRoot, sourcePath);
  const destinationRelative = sourceId === destinationId ? relative : relative.replaceAll(sourceId, destinationId);
  const destinationPath = path.join(targetSessionsRoot, destinationRelative);
  const result = syncSessionFile(sourcePath, destinationPath, sourceId, destinationId, manifest.files[sourceId]);
  recordSyncResult(sourceId, result);
  destinationPaths.set(sourceId, destinationPath);
}

targetState.exec("BEGIN IMMEDIATE");
try {
  const targetThreadColumns = new Set(targetState.prepare("PRAGMA table_info(threads)").all().map((row) => String(row.name)));
  const threadColumns = Object.keys(sourceThreadRows[0] ?? {}).filter((column) => targetThreadColumns.has(column));
  const quotedColumns = threadColumns.map(quoteIdentifier).join(", ");
  const placeholders = threadColumns.map(() => "?").join(", ");
  const updateColumns = threadColumns.filter((column) => column !== "id");
  const threadUpsert = targetState.prepare(`
    INSERT INTO threads (${quotedColumns}) VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updateColumns.map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`).join(", ")}
  `);
  for (const sourceRow of sourceThreadRows) {
    const sourceId = String(sourceRow.id);
    if (protectedThreadIds.has(sourceId)) continue;
    const destinationId = destinationIdFor(sourceId);
    const row = { ...sourceRow, id: destinationId };
    row.rollout_path = destinationPaths.get(sourceId) ?? String(sourceRow.rollout_path ?? "").replace(sourceSessionsRoot, targetSessionsRoot);
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string" && sourceId !== destinationId) row[key] = value.replaceAll(sourceId, destinationId);
    }
    threadUpsert.run(...threadColumns.map((column) => row[column] ?? null));
  }

  for (const table of ["thread_spawn_edges", "thread_dynamic_tools"]) {
    const rows = sourceState.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
    upsertRows(targetState, table, rows, (row) => {
      if (row.parent_thread_id) row.parent_thread_id = destinationIdFor(row.parent_thread_id);
      if (row.child_thread_id) row.child_thread_id = destinationIdFor(row.child_thread_id);
      if (row.thread_id) row.thread_id = destinationIdFor(row.thread_id);
      return row;
    });
  }
  upsertRows(targetState, "thread_sections", sourceState.prepare("SELECT * FROM thread_sections").all());
  targetState.exec("COMMIT");
} catch (error) {
  targetState.exec("ROLLBACK");
  throw error;
}

const sourceProjects = new Map(sourceWeb.prepare("SELECT * FROM projects").all().map((row) => [String(row.id), row]));
const sourceUnused = new Map(sourceWeb.prepare("SELECT * FROM unuse").all().map((row) => [String(row.thread_id), row]));
const projectIds = new Map();
const importedByUser = new Map();
const conflicts = [];
const now = new Date().toISOString();

const sourceTitleWrites = [];
targetWeb.exec("BEGIN IMMEDIATE");
try {
  const ensureUser = targetWeb.prepare(`
    INSERT INTO users (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
  `);
  const findProject = targetWeb.prepare("SELECT id FROM projects WHERE user_id = ? AND root_path = ?");
  const insertProject = targetWeb.prepare(`
    INSERT INTO projects (
      id, user_id, name, root_path, default_model, default_reasoning_effort,
      default_sandbox, default_approval_policy, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateProject = targetWeb.prepare(`
    UPDATE projects SET name = ?, default_model = ?, default_reasoning_effort = ?,
      default_sandbox = ?, default_approval_policy = ?, updated_at = ? WHERE id = ?
  `);
  const existingOwner = targetWeb.prepare("SELECT user_id, project_id, root_path FROM thread_owners WHERE thread_id = ?");
  const existingTitle = targetWeb.prepare("SELECT display_name, display_name_updated_at FROM thread_owners WHERE thread_id = ?");
  const insertOwner = targetWeb.prepare(`
    INSERT INTO thread_owners (
      thread_id, user_id, project_id, root_path, is_pinned, manual_order,
      model_override, reasoning_effort_override, display_name, display_name_updated_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      project_id = excluded.project_id,
      root_path = excluded.root_path,
      is_pinned = excluded.is_pinned,
      manual_order = excluded.manual_order,
      model_override = excluded.model_override,
      reasoning_effort_override = excluded.reasoning_effort_override,
      display_name = CASE
        WHEN excluded.display_name_updated_at IS NOT NULL
          AND (thread_owners.display_name_updated_at IS NULL OR excluded.display_name_updated_at >= thread_owners.display_name_updated_at)
        THEN excluded.display_name ELSE thread_owners.display_name END,
      display_name_updated_at = CASE
        WHEN excluded.display_name_updated_at IS NOT NULL
          AND (thread_owners.display_name_updated_at IS NULL OR excluded.display_name_updated_at >= thread_owners.display_name_updated_at)
        THEN excluded.display_name_updated_at ELSE thread_owners.display_name_updated_at END,
      updated_at = excluded.updated_at
    WHERE thread_owners.user_id = excluded.user_id
  `);
  const insertUnused = targetWeb.prepare(`
    INSERT INTO unuse (thread_id, user_id, project_id, root_path, deleted_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(thread_id, user_id) DO UPDATE SET
      project_id = excluded.project_id, root_path = excluded.root_path, deleted_at = excluded.deleted_at
  `);
  const restoreVisible = targetWeb.prepare("DELETE FROM unuse WHERE thread_id = ? AND user_id = ?");

  for (const owner of sourceOwnerRows) {
    const sourceId = String(owner.thread_id);
    const destinationId = destinationIdFor(sourceId);
    if (protectedThreadIds.has(sourceId) && existingOwner.get(destinationId)) continue;
    const userId = canonicalUserId(owner.user_id);
    const sourceProject = sourceProjects.get(String(owner.project_id));
    if (!sourceProject) {
      conflicts.push({ threadId: sourceId, reason: "missing-source-project" });
      continue;
    }
    const project = canonicalProjectForUser(userId, sourceProject);
    const projectKey = `${userId}\u0000${project.rootPath}`;
    let projectId = projectIds.get(projectKey);
    if (!projectId) {
      ensureUser.run(userId, userId, now, now);
      projectId = findProject.get(userId, project.rootPath)?.id;
      if (!projectId) {
        projectId = randomUUID();
        insertProject.run(
          projectId, userId, project.name, project.rootPath,
          sourceProject.default_model, sourceProject.default_reasoning_effort,
          sourceProject.default_sandbox, sourceProject.default_approval_policy,
          sourceProject.created_at || now, sourceProject.updated_at || now,
        );
      } else {
        updateProject.run(
          project.name, sourceProject.default_model, sourceProject.default_reasoning_effort,
          sourceProject.default_sandbox, sourceProject.default_approval_policy,
          sourceProject.updated_at || now, projectId,
        );
      }
      projectId = String(projectId);
      projectIds.set(projectKey, projectId);
    }

    const existing = existingOwner.get(destinationId);
    if (existing && String(existing.user_id) !== userId) {
      conflicts.push({ threadId: sourceId, destinationId, reason: "different-target-user" });
      continue;
    }
    const state = sourceThreadsById.get(sourceId);
    const sourceDisplayName = String(owner.display_name || state?.name || state?.title || "").trim().slice(0, 512) || null;
    const sourceTitleUpdatedAt = String(owner.display_name_updated_at || "").trim() || null;
    const targetTitle = existingTitle.get(destinationId);
    const targetDisplayName = String(targetTitle?.display_name || "").trim().slice(0, 512) || null;
    const targetTitleUpdatedAt = String(targetTitle?.display_name_updated_at || "").trim() || null;
    const useTargetTitle = Boolean(targetDisplayName && targetTitleUpdatedAt && (!sourceTitleUpdatedAt || targetTitleUpdatedAt >= sourceTitleUpdatedAt));
    const displayName = useTargetTitle ? targetDisplayName : sourceDisplayName;
    const displayNameUpdatedAt = useTargetTitle ? targetTitleUpdatedAt : sourceTitleUpdatedAt;
    if (useTargetTitle && (targetDisplayName !== sourceDisplayName || targetTitleUpdatedAt !== sourceTitleUpdatedAt)) {
      sourceTitleWrites.push({ threadId: sourceId, displayName: targetDisplayName, updatedAt: targetTitleUpdatedAt });
    }
    insertOwner.run(
      destinationId, userId, projectId, project.rootPath,
      Number(owner.is_pinned ?? 0) ? 1 : 0,
      Number.isFinite(Number(owner.manual_order)) ? Number(owner.manual_order) : null,
      owner.model_override || null,
      owner.reasoning_effort_override || null,
      displayName,
      displayNameUpdatedAt,
      owner.created_at || now,
      owner.updated_at || now,
    );
    const unused = sourceUnused.get(sourceId);
    if (unused) insertUnused.run(destinationId, userId, projectId, project.rootPath, unused.deleted_at || now);
    else restoreVisible.run(destinationId, userId);
    importedByUser.set(userId, (importedByUser.get(userId) ?? 0) + 1);
  }
  targetWeb.prepare(`
    DELETE FROM projects
    WHERE name = ?
      AND NOT EXISTS (SELECT 1 FROM thread_owners WHERE thread_owners.project_id = projects.id)
  `).run(migrationProjectName);
  targetWeb.exec("COMMIT");
} catch (error) {
  targetWeb.exec("ROLLBACK");
  throw error;
}

if (sourceTitleWrites.length) {
  const writeSourceTitle = sourceWeb.prepare(
    "UPDATE thread_owners SET display_name = ?, display_name_updated_at = ? WHERE thread_id = ?"
  );
  sourceWeb.exec("BEGIN IMMEDIATE");
  try {
    for (const title of sourceTitleWrites) writeSourceTitle.run(title.displayName, title.updatedAt, title.threadId);
    sourceWeb.exec("COMMIT");
  } catch (error) {
    sourceWeb.exec("ROLLBACK");
    throw error;
  }
}

if (process.env.CODEX_260803_SYNC_SKIP_POOL_STATE !== "true") {
  const poolState = JSON.parse(fs.readFileSync(poolStatePath, "utf8"));
  poolState.threadAccounts = poolState.threadAccounts && typeof poolState.threadAccounts === "object" ? poolState.threadAccounts : {};
  for (const owner of sourceOwnerRows) poolState.threadAccounts[destinationIdFor(owner.thread_id)] = accountId;
  const temporaryPoolState = `${poolStatePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPoolState, `${JSON.stringify(poolState, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPoolState, poolStatePath);
}

manifest.version = 1;
manifest.updatedAt = new Date().toISOString();
const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryManifest, manifestPath);

console.log(JSON.stringify({
  sourceThreads: sourceThreadRows.length,
  sourceOwners: sourceOwnerRows.length,
  overlappingOwnersCloned: overlappingIds.size,
  importedOwners: [...importedByUser.values()].reduce((sum, count) => sum + count, 0),
  users: Object.fromEntries([...importedByUser.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  files: fileResults,
  protectedThreadCount: protectedThreadIds.size,
  conflicts,
  activeThreadClone: cloneIds.get("019f989b-d5c8-7023-bb73-65dfd5a46b8f") ?? null,
}, null, 2));

sourceState.close();
targetState.close();
sourceWeb.close();
targetWeb.close();
