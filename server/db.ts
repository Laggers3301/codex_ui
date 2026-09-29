import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isLegacyGeneratedBranchPin } from "./branchContext.js";
import { defaults, serverConfig } from "./config.js";
import type { CreateProjectInput, LocalSendSettings, Project, ReasoningEffort, UpdateLocalSendSettingsInput, UpdateProjectInput, UserProfile } from "./types.js";

export const ADMIN_USER_ID = "admin";
export const DEFAULT_USER_ID = ADMIN_USER_ID;

type ProjectRow = {
  id: string;
  user_id: string;
  name: string;
  root_path: string;
  default_model: string;
  default_reasoning_effort: string;
  default_sandbox: string;
  default_approval_policy: string;
  created_at: string;
  updated_at: string;
};

type UserRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type UserSettingsRow = {
  user_id: string;
  local_ssh_host: string;
  local_ssh_port: number;
  local_ssh_user: string;
  local_send_path: string;
  local_ssh_identity_file: string;
  local_output_path: string;
  codex_execution_mode?: string;
  created_at?: string;
  updated_at: string;
};

type ThreadOwnerRow = {
  thread_id: string;
  user_id: string;
  project_id: string;
  root_path: string;
  is_pinned: number;
  manual_order: number | null;
  model_override: string | null;
  reasoning_effort_override: string | null;
  display_name: string | null;
  display_name_updated_at: string | null;
  context_pin: string | null;
  context_pin_updated_at: string | null;
  context_profile: string | null;
  context_window_override: number | null;
  auto_compact_token_limit_override: number | null;
  auto_compact_scope_override: string | null;
  context_config_updated_at: string | null;
  created_at: string;
  updated_at: string;
};

type UnusedThreadRow = {
  thread_id: string;
  user_id: string;
  project_id: string;
  root_path: string;
  deleted_at: string;
};

export interface ThreadOwner {
  threadId: string;
  userId: string;
  projectId: string;
  rootPath: string;
  pinned: boolean;
  manualOrder: number | null;
  modelOverride: string | null;
  reasoningEffortOverride: ReasoningEffort | null;
  displayName: string | null;
  displayNameUpdatedAt: string | null;
  contextPin: string | null;
  contextPinUpdatedAt: string | null;
  contextProfile: ThreadContextProfile;
  contextWindowOverride: number | null;
  autoCompactTokenLimitOverride: number | null;
  autoCompactScopeOverride: ThreadContextScope;
  contextConfigUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CodexExecutionMode = "shared" | "dedicated";

export interface ThreadPresentation {
  threadId: string;
  pinned: boolean;
  manualOrder: number | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  displayName: string | null;
}

export interface ThreadContextPin {
  threadId: string;
  text: string;
  updatedAt: string | null;
}

export type ThreadContextProfile = "default" | "balanced" | "long" | "maximum" | "custom";
export type ThreadContextScope = "total" | "body_after_prefix";

export interface ThreadContextConfig {
  threadId: string;
  profile: ThreadContextProfile;
  contextWindow: number | null;
  compactTokenLimit: number | null;
  scope: ThreadContextScope;
  updatedAt: string | null;
}

export interface UnusedThread {
  threadId: string;
  userId: string;
  projectId: string;
  rootPath: string;
  deletedAt: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    rootPath: row.root_path,
    defaultModel: row.default_model,
    defaultReasoningEffort: row.default_reasoning_effort as Project["defaultReasoningEffort"],
    defaultSandbox: row.default_sandbox as Project["defaultSandbox"],
    defaultApprovalPolicy: row.default_approval_policy as Project["defaultApprovalPolicy"],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toUser(row: UserRow): UserProfile {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function emptyLocalSendSettings(): LocalSendSettings {
  return {
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    destinationPath: "",
    identityFile: "",
    outputPath: "/tmp/codex_remote_exports",
    updatedAt: null
  };
}

function toLocalSendSettings(row: UserSettingsRow | undefined): LocalSendSettings {
  if (!row) {
    return emptyLocalSendSettings();
  }
  return {
    sshHost: row.local_ssh_host ?? "",
    sshPort: Number(row.local_ssh_port) || 22,
    sshUser: row.local_ssh_user ?? "",
    destinationPath: row.local_send_path ?? "",
    identityFile: row.local_ssh_identity_file ?? "",
    outputPath: row.local_output_path ?? "/tmp/codex_remote_exports",
    updatedAt: row.updated_at ?? null
  };
}

function toThreadOwner(row: ThreadOwnerRow): ThreadOwner {
  return {
    threadId: row.thread_id,
    userId: row.user_id,
    projectId: row.project_id,
    rootPath: row.root_path,
    pinned: Boolean(row.is_pinned),
    manualOrder: typeof row.manual_order === "number" ? row.manual_order : null,
    modelOverride: row.model_override?.trim() || null,
    reasoningEffortOverride: toReasoningEffort(row.reasoning_effort_override),
    displayName: row.display_name?.trim() || null,
    displayNameUpdatedAt: row.display_name_updated_at || null,
    contextPin: row.context_pin?.trim() || null,
    contextPinUpdatedAt: row.context_pin_updated_at || null,
    contextProfile: toThreadContextProfile(row.context_profile),
    contextWindowOverride: finitePositiveInteger(row.context_window_override),
    autoCompactTokenLimitOverride: finitePositiveInteger(row.auto_compact_token_limit_override),
    autoCompactScopeOverride: toThreadContextScope(row.auto_compact_scope_override),
    contextConfigUpdatedAt: row.context_config_updated_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function toThreadContextProfile(value: unknown): ThreadContextProfile {
  return value === "balanced" || value === "long" || value === "maximum" || value === "custom" ? value : "default";
}

function toThreadContextScope(value: unknown): ThreadContextScope {
  return value === "body_after_prefix" ? value : "total";
}

function toReasoningEffort(value: unknown): ReasoningEffort | null {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"
    ? value
    : null;
}

function toUnusedThread(row: UnusedThreadRow): UnusedThread {
  return {
    threadId: row.thread_id,
    userId: row.user_id,
    projectId: row.project_id,
    rootPath: row.root_path,
    deletedAt: row.deleted_at
  };
}

export class ProjectStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = path.join(serverConfig.dataDir, "codex-web.sqlite")) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // A live mirror may briefly write this database from a second
    // process. WAL keeps ordinary reads available during that write, while a
    // bounded busy timeout turns the remaining write/write race into a short
    // wait instead of an intermittent HTTP 500/502 "database is locked".
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
    `);
    this.migrate();
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversation_timeline (
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
      item_json TEXT NOT NULL, PRIMARY KEY(thread_id, turn_id, item_id)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, subscription_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  savePushSubscription(userId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
    this.db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, subscription_json, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id, subscription_json = excluded.subscription_json, updated_at = excluded.updated_at`)
      .run(subscription.endpoint, userId, JSON.stringify(subscription), new Date().toISOString());
  }

  removePushSubscription(userId: string, endpoint: string): void {
    this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(endpoint, userId);
  }

  listPushSubscriptions(userId: string): Array<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
    return (this.db.prepare("SELECT subscription_json FROM push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 12")
      .all(userId) as Array<{ subscription_json: string }>).map((row) => JSON.parse(row.subscription_json));
  }

  saveTimelineItem(threadId: string, turnId: string, item: Record<string, unknown>): void {
    const previous = this.db.prepare("SELECT item_json FROM conversation_timeline WHERE thread_id = ? AND turn_id = ? AND item_id = ?")
      .get(threadId, turnId, String(item.id)) as { item_json: string } | undefined;
    if (previous) {
      const saved = JSON.parse(previous.item_json) as Record<string, unknown>;
      item = { ...saved, ...item, timelineAt: saved.timelineAt, timelineOrder: saved.timelineOrder };
      for (const key of ["input", "aggregatedOutput"]) {
        if (typeof item[key] === "string" && String(item[key]).includes("[实时预览已截断") && saved[key]) item[key] = saved[key];
      }
    }
    this.db.prepare(`INSERT INTO conversation_timeline VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id, turn_id, item_id) DO UPDATE SET item_json = excluded.item_json`)
      .run(threadId, turnId, String(item.id), JSON.stringify(item));
  }

  readTimelineItems(threadId: string, turnId: string): Record<string, unknown>[] {
    return (this.db.prepare("SELECT item_json FROM conversation_timeline WHERE thread_id = ? AND turn_id = ? ORDER BY rowid")
      .all(threadId, turnId) as { item_json: string }[]).map((row) => JSON.parse(row.item_json));
  }

  readTimelineItem(threadId: string, itemId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT item_json FROM conversation_timeline WHERE thread_id = ? AND item_id = ? LIMIT 1")
      .get(threadId, itemId) as { item_json: string } | undefined;
    return row ? JSON.parse(row.item_json) : null;
  }

  close(): void {
    this.db.close();
  }

  listUsers(): UserProfile[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY updated_at DESC, name ASC").all() as UserRow[];
    return rows.map(toUser);
  }

  getUser(id: string): UserProfile | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  ensureUser(id: string, name = id): UserProfile {
    const cleanId = id.trim();
    const cleanName = (name.trim() || cleanId).trim();
    if (!cleanId) {
      throw new Error("User id is required.");
    }

    const now = new Date().toISOString();
    const existing = this.getUser(cleanId);
    if (!existing) {
      this.db
        .prepare("INSERT INTO users (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run(cleanId, cleanName, now, now);
    } else if (existing.name !== cleanName) {
      this.db.prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?").run(cleanName, now, cleanId);
    }

    const duplicateRows = this.db
      .prepare("SELECT * FROM users WHERE name = ? AND id <> ?")
      .all(cleanName, cleanId) as UserRow[];
    for (const duplicate of duplicateRows) {
      // Preserve projects and thread ownerships that were created before login names became locked to user ids.
      this.db.prepare("UPDATE OR IGNORE projects SET user_id = ? WHERE user_id = ?").run(cleanId, duplicate.id);
      this.db.prepare("UPDATE OR IGNORE thread_owners SET user_id = ? WHERE user_id = ?").run(cleanId, duplicate.id);
      this.db.prepare("UPDATE OR IGNORE unuse SET user_id = ? WHERE user_id = ?").run(cleanId, duplicate.id);
      this.db.prepare("DELETE FROM unuse WHERE user_id = ?").run(duplicate.id);
      this.db.prepare("DELETE FROM thread_owners WHERE user_id = ?").run(duplicate.id);
      this.db.prepare("DELETE FROM projects WHERE user_id = ?").run(duplicate.id);
      this.db.prepare("DELETE FROM users WHERE id = ?").run(duplicate.id);
    }

    return this.getUser(cleanId) ?? { id: cleanId, name: cleanName, createdAt: now, updatedAt: now };
  }

  createUser(name: string): UserProfile {
    const now = new Date().toISOString();
    const user: UserProfile = {
      id: randomUUID(),
      name: name.trim(),
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare("INSERT INTO users (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(user.id, user.name, user.createdAt, user.updatedAt);
    return user;
  }

  deleteUser(id: string): boolean {
    if (id === ADMIN_USER_ID) {
      return false;
    }
    if (!this.getUser(id)) {
      return false;
    }

    this.db.prepare("DELETE FROM unuse WHERE user_id = ?").run(id);
    this.db.prepare("DELETE FROM thread_owners WHERE user_id = ?").run(id);
    this.db.prepare("DELETE FROM projects WHERE user_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return result.changes > 0;
  }

  getLocalSendSettings(userId = DEFAULT_USER_ID): LocalSendSettings {
    const row = this.db.prepare("SELECT * FROM user_settings WHERE user_id = ?").get(userId) as UserSettingsRow | undefined;
    return toLocalSendSettings(row);
  }

  updateLocalSendSettings(userId = DEFAULT_USER_ID, input: UpdateLocalSendSettingsInput): LocalSendSettings {
    this.ensureUser(userId, userId);
    const current = this.getLocalSendSettings(userId);
    const now = new Date().toISOString();
    const existingSettingsRow = this.db.prepare("SELECT created_at FROM user_settings WHERE user_id = ?").get(userId) as { created_at?: string } | undefined;
    const createdAt = existingSettingsRow?.created_at || now;
    const next: LocalSendSettings = {
      sshHost: input.sshHost?.trim() ?? current.sshHost,
      sshPort: input.sshPort && Number.isFinite(input.sshPort) ? Math.trunc(input.sshPort) : current.sshPort || 22,
      sshUser: input.sshUser?.trim() ?? current.sshUser,
      destinationPath: input.destinationPath?.trim() ?? current.destinationPath,
      identityFile: input.identityFile?.trim() ?? current.identityFile,
      outputPath: input.outputPath?.trim() ?? current.outputPath,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO user_settings (
          user_id, local_ssh_host, local_ssh_port, local_ssh_user,
          local_send_path, local_ssh_identity_file, local_output_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          local_ssh_host = excluded.local_ssh_host,
          local_ssh_port = excluded.local_ssh_port,
          local_ssh_user = excluded.local_ssh_user,
          local_send_path = excluded.local_send_path,
          local_ssh_identity_file = excluded.local_ssh_identity_file,
          local_output_path = excluded.local_output_path,
          updated_at = excluded.updated_at`
      )
      .run(userId, next.sshHost, next.sshPort, next.sshUser, next.destinationPath, next.identityFile, next.outputPath, createdAt, now);
    return this.getLocalSendSettings(userId);
  }

  /**
   * A user who has once been assigned a dedicated Codex service must never
   * silently fall back to the shared service if that assignment disappears.
   * The bridge router updates this marker only after it sees an explicit,
   * administrator-controlled dedicated target.
   */
  getCodexExecutionMode(userId = DEFAULT_USER_ID): CodexExecutionMode {
    const row = this.db
      .prepare("SELECT codex_execution_mode FROM user_settings WHERE user_id = ?")
      .get(userId) as { codex_execution_mode?: string } | undefined;
    return row?.codex_execution_mode === "dedicated" ? "dedicated" : "shared";
  }

  setCodexExecutionMode(userId: string, mode: CodexExecutionMode): void {
    const cleanUserId = userId.trim();
    if (!cleanUserId) {
      throw new Error("User id is required for Codex execution routing.");
    }
    this.ensureUser(cleanUserId, cleanUserId);
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT created_at FROM user_settings WHERE user_id = ?")
      .get(cleanUserId) as { created_at?: string } | undefined;
    const createdAt = existing?.created_at || now;
    this.db
      .prepare(
        `INSERT INTO user_settings (
          user_id, local_ssh_host, local_ssh_port, local_ssh_user,
          local_send_path, local_ssh_identity_file, local_output_path,
          codex_execution_mode, created_at, updated_at
        ) VALUES (?, '', 22, '', '', '', '/tmp/codex_remote_exports', ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          codex_execution_mode = excluded.codex_execution_mode,
          updated_at = excluded.updated_at`
      )
      .run(cleanUserId, mode, createdAt, now);
  }

  listProjects(userId = DEFAULT_USER_ID): Project[] {
    const rows = this.db
      .prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC, name ASC")
      .all(userId) as ProjectRow[];
    return rows.map(toProject);
  }

  getProject(id: string, userId = DEFAULT_USER_ID): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").get(id, userId) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : null;
  }

  getProjectByRootPath(rootPath: string, userId = DEFAULT_USER_ID): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE root_path = ? AND user_id = ?").get(rootPath, userId) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : null;
  }

  createProject(input: CreateProjectInput & { rootPath: string; userId?: string }): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      userId: input.userId ?? DEFAULT_USER_ID,
      name: input.name.trim(),
      rootPath: input.rootPath,
      defaultModel: input.defaultModel?.trim() || defaults.model,
      defaultReasoningEffort: input.defaultReasoningEffort ?? defaults.reasoningEffort,
      defaultSandbox: input.defaultSandbox ?? defaults.sandbox,
      defaultApprovalPolicy: input.defaultApprovalPolicy ?? defaults.approvalPolicy,
      createdAt: now,
      updatedAt: now
    };

    this.db
      .prepare(
        `INSERT INTO projects (
          id, user_id, name, root_path, default_model, default_reasoning_effort,
          default_sandbox, default_approval_policy, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.id,
        project.userId,
        project.name,
        project.rootPath,
        project.defaultModel,
        project.defaultReasoningEffort,
        project.defaultSandbox,
        project.defaultApprovalPolicy,
        project.createdAt,
        project.updatedAt
      );

    return project;
  }

  updateProject(id: string, input: UpdateProjectInput, userId = DEFAULT_USER_ID): Project | null {
    const current = this.getProject(id, userId);
    if (!current) {
      return null;
    }

    const next: Project = {
      ...current,
      name: input.name?.trim() || current.name,
      defaultModel: input.defaultModel?.trim() || current.defaultModel,
      defaultReasoningEffort: input.defaultReasoningEffort ?? current.defaultReasoningEffort,
      defaultSandbox: input.defaultSandbox ?? current.defaultSandbox,
      defaultApprovalPolicy: input.defaultApprovalPolicy ?? current.defaultApprovalPolicy,
      updatedAt: new Date().toISOString()
    };

    this.db
      .prepare(
        `UPDATE projects
         SET name = ?, default_model = ?, default_reasoning_effort = ?,
             default_sandbox = ?, default_approval_policy = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`
      )
      .run(
        next.name,
        next.defaultModel,
        next.defaultReasoningEffort,
        next.defaultSandbox,
        next.defaultApprovalPolicy,
        next.updatedAt,
        id,
        userId
      );

    return next;
  }

  deleteProject(id: string, userId = DEFAULT_USER_ID): boolean {
    this.db.prepare("DELETE FROM unuse WHERE project_id = ? AND user_id = ?").run(id, userId);
    this.db.prepare("DELETE FROM thread_owners WHERE project_id = ? AND user_id = ?").run(id, userId);
    const result = this.db.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").run(id, userId);
    return result.changes > 0;
  }

  registerThreadOwner(input: {
    threadId: string;
    userId: string;
    projectId: string;
    rootPath: string;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
  }): ThreadOwner {
    const threadId = input.threadId.trim();
    const userId = input.userId.trim();
    const projectId = input.projectId.trim();
    const rootPath = input.rootPath;
    if (!threadId || !userId || !projectId || !rootPath) {
      throw new Error("Thread ownership requires threadId, userId, projectId, and rootPath.");
    }
    const existing = this.getThreadOwner(threadId);
    if (existing && (existing.userId !== userId || existing.projectId !== projectId)) {
      throw new Error("Thread is already owned by another user or project.");
    }
    const now = new Date().toISOString();
    const manualOrder = this.nextThreadOrder(userId, false);
    const modelOverride = input.model?.trim() || null;
    const reasoningEffortOverride = input.reasoningEffort ?? null;
    this.db
      .prepare(
        `INSERT INTO thread_owners (
          thread_id, user_id, project_id, root_path, is_pinned, manual_order,
          model_override, reasoning_effort_override, created_at, updated_at
        )
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(threadId, userId, projectId, rootPath, manualOrder, modelOverride, reasoningEffortOverride, now, now);
    return this.getThreadOwner(threadId) ?? {
      threadId,
      userId,
      projectId,
      rootPath,
      pinned: false,
      manualOrder,
      modelOverride,
      reasoningEffortOverride,
      displayName: null,
      displayNameUpdatedAt: null,
      contextPin: null,
      contextPinUpdatedAt: null,
      contextProfile: "default",
      contextWindowOverride: null,
      autoCompactTokenLimitOverride: null,
      autoCompactScopeOverride: "total",
      contextConfigUpdatedAt: null,
      createdAt: now,
      updatedAt: now
    };
  }

  touchThreadOwner(threadId: string): void {
    const cleanThreadId = threadId.trim();
    if (cleanThreadId) {
      this.db.prepare("UPDATE thread_owners SET updated_at = ? WHERE thread_id = ?").run(new Date().toISOString(), cleanThreadId);
    }
  }

  getThreadOwner(threadId: string): ThreadOwner | null {
    const cleanThreadId = threadId.trim();
    if (!cleanThreadId) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM thread_owners WHERE thread_id = ?").get(cleanThreadId) as ThreadOwnerRow | undefined;
    return row ? toThreadOwner(row) : null;
  }

  moveThreadOwnerToProject(threadId: string, userId: string, projectId: string, rootPath: string): ThreadOwner | null {
    const cleanThreadId = threadId.trim();
    const owner = this.getThreadOwner(cleanThreadId);
    if (!owner || owner.userId !== userId || !projectId.trim() || !rootPath.trim()) {
      return null;
    }
    this.db.prepare(
      "UPDATE thread_owners SET project_id = ?, root_path = ?, updated_at = ? WHERE thread_id = ? AND user_id = ?"
    ).run(projectId, path.resolve(rootPath), new Date().toISOString(), cleanThreadId, userId);
    return this.getThreadOwner(cleanThreadId);
  }

  getThreadPresentation(userId: string, threadIds: Iterable<string>): Map<string, ThreadPresentation> {
    const cleanUserId = userId.trim();
    const ids = [...new Set([...threadIds].map((threadId) => threadId.trim()).filter(Boolean))];
    if (!cleanUserId || !ids.length) {
      return new Map();
    }
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT thread_id, is_pinned, manual_order, model_override, reasoning_effort_override, display_name
         FROM thread_owners
         WHERE user_id = ? AND thread_id IN (${placeholders})`
      )
      .all(cleanUserId, ...ids) as Array<{
        thread_id: string;
        is_pinned: number;
        manual_order: number | null;
        model_override: string | null;
        reasoning_effort_override: string | null;
        display_name: string | null;
      }>;
    return new Map(rows.map((row) => [row.thread_id, {
      threadId: row.thread_id,
      pinned: Boolean(row.is_pinned),
      manualOrder: typeof row.manual_order === "number" ? row.manual_order : null,
      model: row.model_override?.trim() || null,
      reasoningEffort: toReasoningEffort(row.reasoning_effort_override),
      displayName: row.display_name?.trim() || null
    }]));
  }

  locallyArchivedThreadIds(userId: string, projectId: string): Set<string> {
    const rows = this.db.prepare(
      "SELECT thread_id FROM thread_owners WHERE user_id = ? AND project_id = ? AND is_archived_local = 1"
    ).all(userId, projectId) as Array<{ thread_id: string }>;
    return new Set(rows.map(row => row.thread_id));
  }

  setThreadLocallyArchived(threadId: string, userId: string, projectId: string, archived: boolean): boolean {
    const result = this.db.prepare(
      "UPDATE thread_owners SET is_archived_local = ? WHERE thread_id = ? AND user_id = ? AND project_id = ?"
    ).run(archived ? 1 : 0, threadId, userId, projectId);
    return result.changes > 0;
  }

  updateThreadDisplayName(threadId: string, userId: string, displayName: string): ThreadPresentation | null {
    const cleanThreadId = threadId.trim();
    const cleanUserId = userId.trim();
    const cleanDisplayName = displayName.trim().slice(0, 512);
    if (!cleanThreadId || !cleanUserId || !cleanDisplayName) {
      return null;
    }
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE thread_owners SET display_name = ?, display_name_updated_at = ?, updated_at = ? WHERE thread_id = ? AND user_id = ?")
      .run(cleanDisplayName, now, now, cleanThreadId, cleanUserId);
    return result.changes > 0 ? this.getThreadPresentation(cleanUserId, [cleanThreadId]).get(cleanThreadId) ?? null : null;
  }

  getThreadContextPin(threadId: string, userId: string): ThreadContextPin | null {
    const cleanThreadId = threadId.trim();
    const cleanUserId = userId.trim();
    if (!cleanThreadId || !cleanUserId) return null;
    const row = this.db
      .prepare("SELECT context_pin, context_pin_updated_at FROM thread_owners WHERE thread_id = ? AND user_id = ?")
      .get(cleanThreadId, cleanUserId) as { context_pin?: string | null; context_pin_updated_at?: string | null } | undefined;
    if (!row) return null;
    const storedText = row.context_pin?.trim() || "";
    return {
      threadId: cleanThreadId,
      // Releases before the native-fork implementation stored generated
      // branch summaries in context_pin. Keep those rows intact for audit, but
      // never expose or re-inject them as if the user had pinned them.
      text: isLegacyGeneratedBranchPin(storedText) ? "" : storedText,
      updatedAt: row.context_pin_updated_at || null
    };
  }

  setThreadContextPin(threadId: string, userId: string, text: string): ThreadContextPin | null {
    const cleanThreadId = threadId.trim();
    const cleanUserId = userId.trim();
    const cleanText = text.trim().slice(0, 16_000);
    if (!cleanThreadId || !cleanUserId) return null;
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE thread_owners
         SET context_pin = ?, context_pin_updated_at = ?, updated_at = ?
         WHERE thread_id = ? AND user_id = ?`
      )
      .run(cleanText || null, now, now, cleanThreadId, cleanUserId);
    return result.changes > 0 ? this.getThreadContextPin(cleanThreadId, cleanUserId) : null;
  }

  getThreadContextConfig(threadId: string, userId: string): ThreadContextConfig | null {
    const cleanThreadId = threadId.trim();
    const cleanUserId = userId.trim();
    if (!cleanThreadId || !cleanUserId) return null;
    const row = this.db
      .prepare(
        `SELECT context_profile, context_window_override,
                auto_compact_token_limit_override, auto_compact_scope_override,
                context_config_updated_at
         FROM thread_owners WHERE thread_id = ? AND user_id = ?`
      )
      .get(cleanThreadId, cleanUserId) as Pick<ThreadOwnerRow,
        "context_profile" | "context_window_override" | "auto_compact_token_limit_override" |
        "auto_compact_scope_override" | "context_config_updated_at"> | undefined;
    if (!row) return null;
    return {
      threadId: cleanThreadId,
      profile: toThreadContextProfile(row.context_profile),
      contextWindow: finitePositiveInteger(row.context_window_override),
      compactTokenLimit: finitePositiveInteger(row.auto_compact_token_limit_override),
      scope: toThreadContextScope(row.auto_compact_scope_override),
      updatedAt: row.context_config_updated_at || null
    };
  }

  setThreadContextConfig(
    threadId: string,
    userId: string,
    input: Omit<ThreadContextConfig, "threadId" | "updatedAt">
  ): ThreadContextConfig | null {
    const cleanThreadId = threadId.trim();
    const cleanUserId = userId.trim();
    if (!cleanThreadId || !cleanUserId) return null;
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE thread_owners
         SET context_profile = ?, context_window_override = ?,
             auto_compact_token_limit_override = ?, auto_compact_scope_override = ?,
             context_config_updated_at = ?, updated_at = ?
         WHERE thread_id = ? AND user_id = ?`
      )
      .run(
        input.profile,
        input.contextWindow,
        input.compactTokenLimit,
        input.scope,
        now,
        now,
        cleanThreadId,
        cleanUserId
      );
    return result.changes > 0 ? this.getThreadContextConfig(cleanThreadId, cleanUserId) : null;
  }

  setThreadPinned(threadId: string, userId: string, pinned: boolean): ThreadPresentation | null {
    const cleanThreadId = threadId.trim();
    const cleanUserId = userId.trim();
    if (!cleanThreadId || !cleanUserId) {
      return null;
    }
    const manualOrder = this.nextThreadOrder(cleanUserId, pinned, cleanThreadId);
    const result = this.db
      .prepare(
        `UPDATE thread_owners
         SET is_pinned = ?, manual_order = ?
         WHERE thread_id = ? AND user_id = ?`
      )
      .run(pinned ? 1 : 0, manualOrder, cleanThreadId, cleanUserId);
    return result.changes > 0 ? this.getThreadPresentation(cleanUserId, [cleanThreadId]).get(cleanThreadId) ?? null : null;
  }

  setThreadModelConfig(threadId: string, userId: string, model: string, reasoningEffort: ReasoningEffort): ThreadPresentation | null {
    const cleanThreadId = threadId.trim();
    const cleanUserId = userId.trim();
    const cleanModel = model.trim();
    if (!cleanThreadId || !cleanUserId || !cleanModel) {
      return null;
    }
    const result = this.db
      .prepare(
        `UPDATE thread_owners
         SET model_override = ?, reasoning_effort_override = ?
         WHERE thread_id = ? AND user_id = ?`
      )
      .run(cleanModel, reasoningEffort, cleanThreadId, cleanUserId);
    return result.changes > 0 ? this.getThreadPresentation(cleanUserId, [cleanThreadId]).get(cleanThreadId) ?? null : null;
  }

  setThreadOrder(userId: string, threadIds: Iterable<string>): void {
    const cleanUserId = userId.trim();
    const ids = [...threadIds].map((threadId) => threadId.trim()).filter(Boolean);
    if (!cleanUserId || !ids.length || new Set(ids).size !== ids.length) {
      throw new Error("Thread order requires unique owned thread ids.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(
        `UPDATE thread_owners
         SET manual_order = ?
         WHERE thread_id = ? AND user_id = ?`
      );
      ids.forEach((threadId, index) => update.run(index, threadId, cleanUserId));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Return only threads that are still visible to the given user.  This is the
   * export boundary for cross-host handoff: deleted threads and every other
   * user's data must never enter a handoff archive.
   */
  listVisibleThreadOwnersForUser(userId: string): ThreadOwner[] {
    const cleanUserId = userId.trim();
    if (!cleanUserId) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT thread_owners.*
         FROM thread_owners
         LEFT JOIN unuse
           ON unuse.thread_id = thread_owners.thread_id
          AND unuse.user_id = thread_owners.user_id
         WHERE thread_owners.user_id = ?
           AND unuse.thread_id IS NULL
         ORDER BY thread_owners.updated_at DESC, thread_owners.thread_id ASC`
      )
      .all(cleanUserId) as ThreadOwnerRow[];
    return rows.map(toThreadOwner);
  }

  userCanAccessThread(threadId: string, userId: string, projectId?: string): boolean {
    const owner = this.getThreadOwner(threadId);
    if (!owner || owner.userId !== userId) {
      return false;
    }
    if (projectId && owner.projectId !== projectId) {
      return false;
    }
    return !this.isThreadUnused(threadId, userId);
  }

  softDeleteThread(threadId: string, userId: string, projectId: string, allowAnyOwnedProject = false): UnusedThread | null {
    const cleanThreadId = threadId.trim();
    const owner = this.getThreadOwner(cleanThreadId);
    if (!owner || owner.userId !== userId || (!allowAnyOwnedProject && owner.projectId !== projectId)) {
      return null;
    }
    const deletedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO unuse (thread_id, user_id, project_id, root_path, deleted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, user_id) DO UPDATE SET
           project_id = excluded.project_id,
           root_path = excluded.root_path,
           deleted_at = excluded.deleted_at`
      )
      .run(cleanThreadId, userId, owner.projectId, owner.rootPath, deletedAt);
    return this.getUnusedThread(cleanThreadId, userId);
  }

  restoreThreadFromUnused(threadId: string, userId: string): void {
    const cleanThreadId = threadId.trim();
    if (!cleanThreadId) {
      return;
    }
    this.db.prepare("DELETE FROM unuse WHERE thread_id = ? AND user_id = ?").run(cleanThreadId, userId);
  }

  getUnusedThread(threadId: string, userId: string): UnusedThread | null {
    const row = this.db
      .prepare("SELECT * FROM unuse WHERE thread_id = ? AND user_id = ?")
      .get(threadId.trim(), userId) as UnusedThreadRow | undefined;
    return row ? toUnusedThread(row) : null;
  }

  isThreadUnused(threadId: string, userId: string): boolean {
    return this.getUnusedThread(threadId, userId) !== null;
  }

  ownedThreadIds(userId: string, projectId?: string): Set<string> {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT thread_id FROM thread_owners
             WHERE user_id = ? AND project_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM unuse
                 WHERE unuse.thread_id = thread_owners.thread_id AND unuse.user_id = thread_owners.user_id
               )`
          )
          .all(userId, projectId) as Array<{ thread_id: string }>)
      : (this.db
          .prepare(
            `SELECT thread_id FROM thread_owners
             WHERE user_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM unuse
                 WHERE unuse.thread_id = thread_owners.thread_id AND unuse.user_id = thread_owners.user_id
               )`
          )
          .all(userId) as Array<{ thread_id: string }>);
    return new Set(rows.map((row) => row.thread_id));
  }

  getProjectHookTrust(userId: string, projectId: string): Map<string, string> {
    const rows = this.db.prepare("SELECT hook_key, trusted_hash FROM project_hook_trust WHERE user_id = ? AND project_id = ?")
      .all(userId, projectId) as Array<{ hook_key: string; trusted_hash: string }>;
    return new Map(rows.map(row => [row.hook_key, row.trusted_hash]));
  }

  setProjectHookTrust(userId: string, projectId: string, key: string, hash: string | null): void {
    if (!this.getProject(projectId, userId)) throw new Error("Project not found.");
    if (hash) {
      this.db.prepare(`INSERT INTO project_hook_trust (user_id, project_id, hook_key, trusted_hash, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, project_id, hook_key)
        DO UPDATE SET trusted_hash = excluded.trusted_hash, updated_at = excluded.updated_at`)
        .run(userId, projectId, key, hash, new Date().toISOString());
    } else {
      this.db.prepare("DELETE FROM project_hook_trust WHERE user_id = ? AND project_id = ? AND hook_key = ?")
        .run(userId, projectId, key);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureAdminUser();
    this.createUserSettingsTable();
    this.migrateProjectsTable();
    this.createThreadOwnersTable();
    this.createUnuseTable();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_hook_trust (
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        hook_key TEXT NOT NULL,
        trusted_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, project_id, hook_key),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
    `);
  }

  private ensureAdminUser(): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO users (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`
      )
      .run(ADMIN_USER_ID, "admin", now, now);
  }

  private migrateProjectsTable(): void {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
    if (!table) {
      this.createProjectsTable();
      return;
    }

    const columns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const hasUserId = columns.some((column) => column.name === "user_id");
    const needsRebuild = !hasUserId;

    if (!needsRebuild) {
      this.ensureProjectColumns();
      return;
    }

    this.db.exec("ALTER TABLE projects RENAME TO projects_legacy");
    this.createProjectsTable();
    const userIdSelect = hasUserId ? `COALESCE(user_id, '${DEFAULT_USER_ID}')` : `'${DEFAULT_USER_ID}'`;
    this.db.exec(`
      INSERT OR IGNORE INTO projects (
        id, user_id, name, root_path, default_model, default_reasoning_effort,
        default_sandbox, default_approval_policy, created_at, updated_at
      )
      SELECT
        id,
        ${userIdSelect},
        name,
        root_path,
        COALESCE(NULLIF(default_model, ''), '${defaults.model}'),
        '${defaults.reasoningEffort}',
        CASE WHEN default_sandbox = 'workspace-write' THEN '${defaults.sandbox}' ELSE default_sandbox END,
        CASE WHEN default_approval_policy = 'on-request' THEN '${defaults.approvalPolicy}' ELSE default_approval_policy END,
        created_at,
        updated_at
      FROM projects_legacy;
      DROP TABLE projects_legacy;
    `);
    this.ensureProjectColumns();
  }

  private createProjectsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT '${DEFAULT_USER_ID}',
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        default_model TEXT NOT NULL DEFAULT '${defaults.model}',
        default_reasoning_effort TEXT NOT NULL DEFAULT '${defaults.reasoningEffort}',
        default_sandbox TEXT NOT NULL DEFAULT '${defaults.sandbox}',
        default_approval_policy TEXT NOT NULL DEFAULT '${defaults.approvalPolicy}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, root_path),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_projects_user_updated_at ON projects(user_id, updated_at);
    `);
  }

  private createUserSettingsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        local_ssh_host TEXT NOT NULL DEFAULT '',
        local_ssh_port INTEGER NOT NULL DEFAULT 22,
        local_ssh_user TEXT NOT NULL DEFAULT '',
        local_send_path TEXT NOT NULL DEFAULT '',
        local_ssh_identity_file TEXT NOT NULL DEFAULT '',
        local_output_path TEXT NOT NULL DEFAULT '/tmp/codex_remote_exports',
        codex_execution_mode TEXT NOT NULL DEFAULT 'shared',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);
    let columns = this.db.prepare("PRAGMA table_info(user_settings)").all() as Array<{ name: string }>;
    const hasColumn = (name: string) => columns.some((column) => column.name === name);
    const addColumn = (name: string, sql: string) => {
      if (!hasColumn(name)) {
        this.db.prepare(sql).run();
        columns = this.db.prepare("PRAGMA table_info(user_settings)").all() as Array<{ name: string }>;
      }
    };
    addColumn("local_ssh_host", "ALTER TABLE user_settings ADD COLUMN local_ssh_host TEXT NOT NULL DEFAULT ''");
    addColumn("local_ssh_port", "ALTER TABLE user_settings ADD COLUMN local_ssh_port INTEGER NOT NULL DEFAULT 22");
    addColumn("local_ssh_user", "ALTER TABLE user_settings ADD COLUMN local_ssh_user TEXT NOT NULL DEFAULT ''");
    addColumn("local_send_path", "ALTER TABLE user_settings ADD COLUMN local_send_path TEXT NOT NULL DEFAULT ''");
    addColumn("local_ssh_identity_file", "ALTER TABLE user_settings ADD COLUMN local_ssh_identity_file TEXT NOT NULL DEFAULT ''");
    addColumn("local_output_path", "ALTER TABLE user_settings ADD COLUMN local_output_path TEXT NOT NULL DEFAULT '/tmp/codex_remote_exports'");
    addColumn("codex_execution_mode", "ALTER TABLE user_settings ADD COLUMN codex_execution_mode TEXT NOT NULL DEFAULT 'shared'");
    addColumn("created_at", "ALTER TABLE user_settings ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");

    const finalColumns = this.db.prepare("PRAGMA table_info(user_settings)").all() as Array<{ name: string }>;
    const finalHas = (name: string) => finalColumns.some((column) => column.name === name);
    if (finalHas("ssh_port")) {
      this.db.prepare("UPDATE user_settings SET local_ssh_port = ssh_port WHERE local_ssh_port = 22 AND ssh_port IS NOT NULL").run();
    }
    if (finalHas("ssh_destination_path")) {
      this.db.prepare("UPDATE user_settings SET local_send_path = ssh_destination_path WHERE local_send_path = '' AND ssh_destination_path IS NOT NULL AND ssh_destination_path <> ''").run();
    }
    if (finalHas("ssh_target")) {
      this.db.prepare("UPDATE user_settings SET local_ssh_host = ssh_target WHERE local_ssh_host = '' AND ssh_target IS NOT NULL AND ssh_target <> '' AND instr(ssh_target, '@') = 0").run();
      this.db.prepare("UPDATE user_settings SET local_ssh_user = substr(ssh_target, 1, instr(ssh_target, '@') - 1), local_ssh_host = substr(ssh_target, instr(ssh_target, '@') + 1) WHERE local_ssh_host = '' AND ssh_target IS NOT NULL AND instr(ssh_target, '@') > 1").run();
    }
  }

  private createThreadOwnersTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_owners (
        thread_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_archived_local INTEGER NOT NULL DEFAULT 0,
        manual_order INTEGER,
        model_override TEXT,
        reasoning_effort_override TEXT,
        display_name TEXT,
        display_name_updated_at TEXT,
        context_pin TEXT,
        context_pin_updated_at TEXT,
        context_profile TEXT NOT NULL DEFAULT 'default',
        context_window_override INTEGER,
        auto_compact_token_limit_override INTEGER,
        auto_compact_scope_override TEXT NOT NULL DEFAULT 'total',
        context_config_updated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_thread_owners_user_project_updated_at ON thread_owners(user_id, project_id, updated_at);
    `);
    const columns = this.db.prepare("PRAGMA table_info(thread_owners)").all() as Array<{ name: string }>;
    const hasColumn = (name: string) => columns.some((column) => column.name === name);
    if (!hasColumn("is_pinned")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
    }
    if (!hasColumn("is_archived_local")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN is_archived_local INTEGER NOT NULL DEFAULT 0");
    }
    if (!hasColumn("manual_order")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN manual_order INTEGER");
    }
    if (!hasColumn("model_override")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN model_override TEXT");
    }
    if (!hasColumn("reasoning_effort_override")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN reasoning_effort_override TEXT");
    }
    if (!hasColumn("display_name")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN display_name TEXT");
    }
    if (!hasColumn("display_name_updated_at")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN display_name_updated_at TEXT");
    }
    if (!hasColumn("context_pin")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN context_pin TEXT");
    }
    if (!hasColumn("context_pin_updated_at")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN context_pin_updated_at TEXT");
    }
    if (!hasColumn("context_profile")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN context_profile TEXT NOT NULL DEFAULT 'default'");
    }
    if (!hasColumn("context_window_override")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN context_window_override INTEGER");
    }
    if (!hasColumn("auto_compact_token_limit_override")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN auto_compact_token_limit_override INTEGER");
    }
    if (!hasColumn("auto_compact_scope_override")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN auto_compact_scope_override TEXT NOT NULL DEFAULT 'total'");
    }
    if (!hasColumn("context_config_updated_at")) {
      this.db.exec("ALTER TABLE thread_owners ADD COLUMN context_config_updated_at TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_thread_owners_user_pinned_order ON thread_owners(user_id, is_pinned, manual_order)");
  }

  private nextThreadOrder(userId: string, pinned: boolean, excludeThreadId?: string): number {
    const row = excludeThreadId
      ? this.db
          .prepare(
            `SELECT MIN(manual_order) AS minimum_order
             FROM thread_owners
             WHERE user_id = ? AND is_pinned = ? AND thread_id <> ? AND manual_order IS NOT NULL`
          )
          .get(userId, pinned ? 1 : 0, excludeThreadId) as { minimum_order?: number | null } | undefined
      : this.db
          .prepare(
            `SELECT MIN(manual_order) AS minimum_order
             FROM thread_owners
             WHERE user_id = ? AND is_pinned = ? AND manual_order IS NOT NULL`
          )
          .get(userId, pinned ? 1 : 0) as { minimum_order?: number | null } | undefined;
    return typeof row?.minimum_order === "number" ? row.minimum_order - 1 : 0;
  }

  private createUnuseTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS unuse (
        thread_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, user_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(thread_id) REFERENCES thread_owners(thread_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_unuse_user_project_deleted_at ON unuse(user_id, project_id, deleted_at);
    `);
  }

  private ensureProjectColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const hasReasoningEffort = columns.some((column) => column.name === "default_reasoning_effort");
    if (!hasReasoningEffort) {
      this.db.exec(`ALTER TABLE projects ADD COLUMN default_reasoning_effort TEXT NOT NULL DEFAULT '${defaults.reasoningEffort}'`);
    }
    this.db.exec(`
      UPDATE projects
      SET
        default_model = CASE WHEN default_model = '' THEN '${defaults.model}' ELSE default_model END,
        default_reasoning_effort = CASE
          WHEN default_reasoning_effort IS NULL OR default_reasoning_effort = '' THEN '${defaults.reasoningEffort}'
          ELSE default_reasoning_effort
        END,
        default_sandbox = CASE WHEN default_sandbox = 'workspace-write' THEN '${defaults.sandbox}' ELSE default_sandbox END,
        default_approval_policy = CASE
          WHEN default_approval_policy = 'on-request' THEN '${defaults.approvalPolicy}'
          ELSE default_approval_policy
        END
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_projects_user_updated_at ON projects(user_id, updated_at)");
  }
}
