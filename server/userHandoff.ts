import { constants as fsConstants, createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import type { ProjectStore, ThreadOwner } from "./db.js";
import { serverConfig } from "./config.js";
import { findThreadJsonlPathById } from "./threadFallback.js";

export const userHandoffFormat = "codex-web-user-handoff";
export const userHandoffVersion = 1;

const handoffSourceAliases = new Map<string, string[]>([
  ["wjm", ["jiaming"]],
  ["jyh", ["jiangyuhua"]],
  ["wxr", ["wangxuran"]],
  ["wm", ["wuming", "吴明"]],
  ["xjy", ["xujiayu", "x'j'y"]]
]);

export interface UserHandoffSession {
  threadId: string;
  sessionRelativePath: string;
  bytes: number;
  sourceProjectId: string;
  sourceRootPath: string;
  sourceName?: string;
}

export interface UserHandoffManifest {
  format: typeof userHandoffFormat;
  version: typeof userHandoffVersion;
  exportedAt: string;
  sourceLabel: string;
  userId: string;
  sourceOwnedThreadCount: number;
  sessions: UserHandoffSession[];
  skippedThreadIds: string[];
}

export interface StagedUserHandoffExport {
  workDir: string;
  manifest: UserHandoffManifest;
}

export interface ImportedUserHandoff {
  sourceLabel: string;
  projectId: string | null;
  projectName: string | null;
  sourceOwnedThreadCount: number;
  sourceSessionCount: number;
  importedThreadIds: string[];
  alreadyPresentThreadIds: string[];
  skippedThreadIds: string[];
  threadNames: Array<{ threadId: string; name: string }>;
}

function configuredCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

function sourceThreadNames(threadIds: string[]): Map<string, string> {
  const databasePath = path.join(configuredCodexHome(), "state_5.sqlite");
  const names = new Map<string, string>();
  if (!existsSync(databasePath)) {
    return names;
  }
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const statement = database.prepare("SELECT name, title FROM threads WHERE id = ?");
    for (const threadId of threadIds) {
      const row = statement.get(threadId) as { name?: unknown; title?: unknown } | undefined;
      const explicitName = typeof row?.name === "string" ? row.name.trim() : "";
      const legacyTitle = typeof row?.title === "string" ? row.title.trim() : "";
      const name = explicitName || legacyTitle;
      if (name) {
        names.set(threadId, name.slice(0, 512));
      }
    }
  } catch {
    // A missing/older Codex state DB must not prevent JSONL handoff.
  } finally {
    database?.close();
  }
  return names;
}

export function codexSessionsRoot(): string {
  return path.join(configuredCodexHome(), "sessions");
}

function cleanUserId(userId: string): string {
  const clean = userId.trim();
  if (!clean || clean.length > 128 || /[\0\r\n]/.test(clean)) {
    throw new Error("迁移用户名无效。");
  }
  return clean;
}

function safeRelativeSessionPath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  if (!normalized.endsWith(".jsonl")) {
    return null;
  }
  return normalized;
}

function safeUserDirectoryName(userId: string): string {
  const compact = userId.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[_ .-]+|[_ .-]+$/g, "");
  return compact || `user-${createHash("sha256").update(userId).digest("hex").slice(0, 12)}`;
}

function safeSourceLabel(value: string): string {
  const clean = value.trim().replace(/[\0\r\n]/g, "");
  return clean.slice(0, 96) || "remote";
}

function assertPathInside(candidate: string, root: string): void {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  if (!resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("迁移文件路径越界。");
  }
}

async function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function isSameRegularFile(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.lstat(left), fs.lstat(right)]);
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) {
    return false;
  }
  return (await sha256(left)) === (await sha256(right));
}

async function makePrivateDirectory(prefix: string): Promise<string> {
  const root = path.join(os.tmpdir(), prefix);
  await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  return fs.mkdtemp(root);
}

/** Stage the current user's visible JSONL sessions into a self-contained archive directory. */
export async function stageUserHandoffExport(
  store: ProjectStore,
  userId: string,
  sourceLabel: string
): Promise<StagedUserHandoffExport> {
  const cleanUser = cleanUserId(userId);
  const sessionsRoot = codexSessionsRoot();
  const workDir = await makePrivateDirectory("codex-web-handoff-export-");
  const archiveSessionsRoot = path.join(workDir, "sessions");
  const sourceUserIds = [cleanUser, ...(handoffSourceAliases.get(cleanUser) ?? [])];
  const ownersByThreadId = new Map<string, ThreadOwner>();
  for (const sourceUserId of sourceUserIds) {
    for (const owner of store.listVisibleThreadOwnersForUser(sourceUserId)) {
      if (!ownersByThreadId.has(owner.threadId)) ownersByThreadId.set(owner.threadId, owner);
    }
  }
  const owners = [...ownersByThreadId.values()];
  const threadNames = sourceThreadNames(owners.map((owner) => owner.threadId));
  const sessions: UserHandoffSession[] = [];
  const skippedThreadIds: string[] = [];

  try {
    await fs.mkdir(archiveSessionsRoot, { recursive: true, mode: 0o700 });
    for (const owner of owners) {
      const sourcePath = await findThreadJsonlPathById(owner.threadId, sessionsRoot);
      if (!sourcePath) {
        skippedThreadIds.push(owner.threadId);
        continue;
      }
      const resolvedSource = path.resolve(sourcePath);
      const relative = safeRelativeSessionPath(path.relative(sessionsRoot, resolvedSource));
      if (!relative) {
        skippedThreadIds.push(owner.threadId);
        continue;
      }
      const sourceStat = await fs.lstat(resolvedSource).catch(() => null);
      if (!sourceStat?.isFile()) {
        skippedThreadIds.push(owner.threadId);
        continue;
      }
      const archivePath = path.join(archiveSessionsRoot, relative);
      assertPathInside(archivePath, archiveSessionsRoot);
      await fs.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
      await fs.copyFile(resolvedSource, archivePath, fsConstants.COPYFILE_EXCL);
      await fs.chmod(archivePath, 0o600);
      sessions.push({
        threadId: owner.threadId,
        sessionRelativePath: relative,
        bytes: sourceStat.size,
        sourceProjectId: owner.projectId,
        sourceRootPath: owner.rootPath,
        sourceName: threadNames.get(owner.threadId)
      });
    }

    const manifest: UserHandoffManifest = {
      format: userHandoffFormat,
      version: userHandoffVersion,
      exportedAt: new Date().toISOString(),
      sourceLabel: safeSourceLabel(sourceLabel),
      userId: cleanUser,
      sourceOwnedThreadCount: owners.length,
      sessions,
      skippedThreadIds
    };
    await fs.writeFile(path.join(workDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return { workDir, manifest };
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function removeStagedUserHandoff(workDir: string): Promise<void> {
  await fs.rm(workDir, { recursive: true, force: true });
}

function parseManifest(value: unknown, expectedUserId: string): UserHandoffManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("迁移包缺少 manifest。");
  }
  const candidate = value as Partial<UserHandoffManifest>;
  if (candidate.format !== userHandoffFormat || candidate.version !== userHandoffVersion || candidate.userId !== expectedUserId || !Array.isArray(candidate.sessions)) {
    throw new Error("迁移包格式或用户不匹配。");
  }
  const seen = new Set<string>();
  const sessions: UserHandoffSession[] = [];
  for (const item of candidate.sessions) {
    if (!item || typeof item !== "object") {
      throw new Error("迁移包会话条目无效。");
    }
    const record = item as Partial<UserHandoffSession>;
    const threadId = typeof record.threadId === "string" ? record.threadId.trim() : "";
    const relative = typeof record.sessionRelativePath === "string" ? safeRelativeSessionPath(record.sessionRelativePath) : null;
    if (!/^[a-zA-Z0-9_-]+$/.test(threadId) || !relative || seen.has(threadId)) {
      throw new Error("迁移包包含无效或重复会话。");
    }
    seen.add(threadId);
    sessions.push({
      threadId,
      sessionRelativePath: relative,
      bytes: typeof record.bytes === "number" && Number.isFinite(record.bytes) && record.bytes >= 0 ? record.bytes : 0,
      sourceProjectId: typeof record.sourceProjectId === "string" ? record.sourceProjectId.slice(0, 256) : "",
      sourceRootPath: typeof record.sourceRootPath === "string" ? record.sourceRootPath.slice(0, 4096) : "",
      sourceName: typeof record.sourceName === "string" && record.sourceName.trim()
        ? record.sourceName.trim().slice(0, 512)
        : undefined
    });
  }
  return {
    format: userHandoffFormat,
    version: userHandoffVersion,
    exportedAt: typeof candidate.exportedAt === "string" ? candidate.exportedAt : "",
    sourceLabel: safeSourceLabel(typeof candidate.sourceLabel === "string" ? candidate.sourceLabel : "remote"),
    userId: expectedUserId,
    sourceOwnedThreadCount: typeof candidate.sourceOwnedThreadCount === "number" ? Math.max(0, Math.trunc(candidate.sourceOwnedThreadCount)) : sessions.length,
    sessions,
    skippedThreadIds: Array.isArray(candidate.skippedThreadIds)
      ? candidate.skippedThreadIds.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]+$/.test(id))
      : []
  };
}

async function importedProjectForUser(store: ProjectStore, userId: string, sourceLabel: string, projectRoot: string) {
  const directoryName = sourceLabel.trim().toLowerCase() === "codex1"
    ? "codex1-migrated"
    : `migrated-from-${safeUserDirectoryName(sourceLabel)}`;
  const root = path.join(path.resolve(projectRoot), "users", safeUserDirectoryName(userId), directoryName);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return store.getProjectByRootPath(root, userId) ?? store.createProject({
    userId,
    name: `${sourceLabel} 迁移会话`,
    rootPath: root
  });
}

/** Import a verified, already-extracted archive. */
export async function importStagedUserHandoff(
  store: ProjectStore,
  userId: string,
  extractedDirectory: string,
  projectRoot: string,
  options: { overwriteExisting?: boolean; targetCodexHome?: string } = {}
): Promise<ImportedUserHandoff> {
  const cleanUser = cleanUserId(userId);
  const manifestPath = path.join(extractedDirectory, "manifest.json");
  const manifest = parseManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")), cleanUser);
  // A refreshed source handoff must not resurrect a conversation that was
  // deliberately replaced by a verified fork on the user's dedicated account.
  const migratedSourceIds = new Set<string>();
  if (cleanUser === serverConfig.trackedQuotaUser && serverConfig.trackedQuotaAllowedAccountId) {
    const journalPath = path.join(serverConfig.dataDir, `${cleanUser}-${serverConfig.trackedQuotaAllowedAccountId}-migration.json`);
    try {
      const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as Record<string, { verified?: boolean; targetThreadId?: string }>;
      for (const [threadId, entry] of Object.entries(journal)) {
        if (entry.verified && entry.targetThreadId) migratedSourceIds.add(threadId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const archiveSessionsRoot = path.join(extractedDirectory, "sessions");
  const targetSessionsRoot = options.targetCodexHome
    ? path.join(path.resolve(options.targetCodexHome), "sessions")
    : codexSessionsRoot();

  type CopyPlan = { entry: UserHandoffSession; sourcePath: string; destinationPath: string; alreadyPresent: boolean };
  const plans: CopyPlan[] = [];
  for (const entry of manifest.sessions) {
    const sourcePath = path.join(archiveSessionsRoot, entry.sessionRelativePath);
    const destinationPath = path.join(targetSessionsRoot, entry.sessionRelativePath);
    assertPathInside(sourcePath, archiveSessionsRoot);
    assertPathInside(destinationPath, targetSessionsRoot);
    const sourceStat = await fs.lstat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile()) {
      throw new Error(`迁移包缺少会话文件：${entry.threadId}`);
    }
    const owner = store.getThreadOwner(entry.threadId);
    if (owner && owner.userId !== cleanUser) {
      throw new Error(`目标端存在其他用户的同名会话：${entry.threadId}`);
    }
    const destinationStat = await fs.lstat(destinationPath).catch(() => null);
    if (destinationStat && !destinationStat.isFile()) {
      throw new Error(`目标端会话路径不是普通文件：${entry.threadId}`);
    }
    plans.push({ entry, sourcePath, destinationPath, alreadyPresent: Boolean(destinationStat) });
  }

  if (!plans.length) {
    return {
      sourceLabel: manifest.sourceLabel,
      projectId: null,
      projectName: null,
      sourceOwnedThreadCount: manifest.sourceOwnedThreadCount,
      sourceSessionCount: 0,
      importedThreadIds: [],
      alreadyPresentThreadIds: [],
      skippedThreadIds: manifest.skippedThreadIds,
      threadNames: []
    };
  }

  store.ensureUser(cleanUser, cleanUser);
  const project = await importedProjectForUser(store, cleanUser, manifest.sourceLabel, projectRoot);
  const importedThreadIds: string[] = [];
  const alreadyPresentThreadIds: string[] = [];

  for (const plan of plans) {
    if (plan.alreadyPresent && !options.overwriteExisting) {
      alreadyPresentThreadIds.push(plan.entry.threadId);
    } else {
      await fs.mkdir(path.dirname(plan.destinationPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${plan.destinationPath}.handoff-${randomUUID()}.tmp`;
      await fs.copyFile(plan.sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL);
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, plan.destinationPath);
      importedThreadIds.push(plan.entry.threadId);
    }
    if (plan.alreadyPresent && !options.overwriteExisting) {
      continue;
    }
    const existingOwner = store.getThreadOwner(plan.entry.threadId);
    if (!existingOwner) {
      store.registerThreadOwner({
        threadId: plan.entry.threadId,
        userId: cleanUser,
        projectId: project.id,
        rootPath: project.rootPath
      });
    } else if (existingOwner.userId === cleanUser) {
      // Re-running a handoff keeps the existing JSONL but converges every source
      // session into the dedicated receiving workspace.
      store.moveThreadOwnerToProject(plan.entry.threadId, cleanUser, project.id, project.rootPath);
    }
    // The source export contains visible sessions only. A stale local soft-delete
    // must not keep a successfully refreshed source conversation hidden.
    if (!migratedSourceIds.has(plan.entry.threadId)) store.restoreThreadFromUnused(plan.entry.threadId, cleanUser);
    if (plan.entry.sourceName) {
      const updateDisplayName = (store as ProjectStore & {
        updateThreadDisplayName?: (threadId: string, userId: string, displayName: string) => unknown;
      }).updateThreadDisplayName;
      if (typeof updateDisplayName === "function") {
        updateDisplayName.call(store, plan.entry.threadId, cleanUser, plan.entry.sourceName);
      }
    }
  }

  return {
    sourceLabel: manifest.sourceLabel,
    projectId: project.id,
    projectName: project.name,
    sourceOwnedThreadCount: manifest.sourceOwnedThreadCount,
    sourceSessionCount: manifest.sessions.length,
    importedThreadIds,
    alreadyPresentThreadIds,
    skippedThreadIds: manifest.skippedThreadIds,
    threadNames: manifest.sessions.flatMap((entry) => entry.sourceName
      ? [{ threadId: entry.threadId, name: entry.sourceName }]
      : [])
  };
}
