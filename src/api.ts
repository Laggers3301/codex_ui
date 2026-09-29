import type {
  ApprovalPolicy,
  CodexAccountPool,
  CodexLeaderboard,
  CodexQuota,
  CodexSkillsResponse,
  DirectoryListResponse,
  ModelProfile,
  LocalSendResult,
  LocalSendSettings,
  LocalSendTestResult,
  ThreadExportFormat,
  ThreadExportResult,
  ThreadContextPin,
  ThreadContextConfig,
  ThreadContextProfile,
  ThreadContextScope,
  ThreadContextStatus,
  Project,
  ProjectFile,
  ProjectFilePreview,
  ReasoningEffort,
  SandboxMode,
  SessionMigrationResult,
  ThreadPresentation,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadSummary,
  ThreadSearchMatch,
  TrackedQuotaUsage,
  UserProfile
} from "./types";

const defaultUserId = "admin";
export const THREAD_READ_MAX_LIMIT = 240;

let currentUserId = localStorage.getItem("codex-web-user-id") || defaultUserId;

export function setApiUserId(userId: string): void {
  currentUserId = userId || defaultUserId;
  localStorage.setItem("codex-web-user-id", currentUserId);
}

export function getApiUserId(): string {
  return currentUserId;
}

export function getPushPublicKey(): Promise<{ data: { publicKey: string } }> {
  return request("/api/push/key");
}

export function savePushSubscription(subscription: PushSubscriptionJSON): Promise<{ ok: boolean }> {
  return request("/api/push/subscription", { method: "POST", body: JSON.stringify(subscription) });
}

export function removePushSubscription(endpoint: string): Promise<{ ok: boolean }> {
  return request("/api/push/subscription", { method: "DELETE", body: JSON.stringify({ endpoint }) });
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  headers.set("x-codex-web-user-id", currentUserId);
  const isFormData = typeof FormData !== "undefined" && options?.body instanceof FormData;
  if (options?.body !== undefined && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers
    });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    throw new Error(`网络请求失败 ${path}: ${detail}`);
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message ? `${body.error ?? "Request failed"}: ${body.message}` : body.error;
    throw new Error(message ?? `Request failed: ${response.status}`);
  }
  return body as T;
}

export function listUsers(): Promise<{ data: UserProfile[]; defaultUserId: string; lockedToLoginUser?: boolean }> {
  return request("/api/users");
}

export function listModels(): Promise<{ data: ModelProfile[]; defaultModel: string; defaultReasoningEffort: ReasoningEffort }> {
  return request("/api/models");
}

export function readCodexQuota(refresh = false): Promise<{ data: CodexQuota }> {
  const suffix = refresh ? "?refresh=true" : "";
  return request(`/api/codex/quota${suffix}`, { cache: "no-store" });
}

export function readCodexAccountPool(refresh = false, threadId?: string | null): Promise<{ data: CodexAccountPool }> {
  const params = new URLSearchParams();
  if (refresh) params.set("refresh", "true");
  if (threadId?.trim()) params.set("threadId", threadId.trim());
  const suffix = params.size ? `?${params.toString()}` : "";
  return request(`/api/codex/account-pool${suffix}`, { cache: "no-store" });
}

export function readCodexLeaderboard(refresh = false): Promise<{ data: CodexLeaderboard }> {
  const suffix = refresh ? "?refresh=true" : "";
  return request(`/api/codex/leaderboard${suffix}`, { cache: "no-store" });
}

export function readTrackedQuotaUsage(refresh = false): Promise<{ data: TrackedQuotaUsage }> {
  const suffix = refresh ? "?refresh=true" : "";
  return request(`/api/codex/tracked-quota${suffix}`, { cache: "no-store" });
}

export function listCodexSkills(projectId?: string, reload = false): Promise<CodexSkillsResponse> {
  const params = new URLSearchParams();
  if (projectId) {
    params.set("projectId", projectId);
  }
  if (reload) {
    params.set("reload", "true");
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/codex/skills${suffix}`);
}

export interface McpServerSummary {
  name: string;
  pluginId: string | null;
  runtimeStatus: string | null;
  authStatus: string;
  toolCount: number;
}

export function readThreadMcpStatus(projectId: string, threadId: string): Promise<{
  data: McpServerSummary[];
  nextCursor: string | null;
  sharedRuntimeWarning: string;
}> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/mcp-status`, { cache: "no-store" });
}

export function createUser(input: { name: string }): Promise<{ data: UserProfile }> {
  return request("/api/users", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteUser(id: string): Promise<{ ok: boolean }> {
  return request(`/api/users/${id}`, { method: "DELETE" });
}

export function readLocalSendSettings(): Promise<{ data: LocalSendSettings; detectedClientHost: string }> {
  return request("/api/settings/local-send");
}

export function updateLocalSendSettings(input: Partial<LocalSendSettings>): Promise<{ data: LocalSendSettings }> {
  return request("/api/settings/local-send", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function testLocalSendSettings(): Promise<{ data: LocalSendTestResult }> {
  return request("/api/settings/local-send/test", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function sendProjectFileToLocal(projectId: string, filePath: string, destinationPath?: string): Promise<{ data: LocalSendResult }> {
  return request(`/api/projects/${projectId}/files/send-local`, {
    method: "POST",
    body: JSON.stringify({ path: filePath, destinationPath })
  });
}

export function exportThreadRecord(
  projectId: string,
  threadId: string,
  input: { format?: ThreadExportFormat; sendLocal?: boolean; outputPath?: string; destinationPath?: string }
): Promise<{ data: ThreadExportResult }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/export`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export interface SessionMigrationJob {
  id: string;
  status: "running" | "completed" | "failed";
  phase: "connecting" | "transferring" | "extracting" | "importing" | "completed" | "failed";
  bytesTransferred: number;
  startedAt: string;
  updatedAt: string;
  result?: SessionMigrationResult;
  message?: string;
  error?: string;
}

export function migrateSessionsFrom4090(): Promise<{ data: SessionMigrationJob }> {
  return request("/api/handoff/from-4090-left", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function readSessionMigrationFrom4090(jobId: string): Promise<{ data: SessionMigrationJob }> {
  return request(`/api/handoff/from-4090-left/status/${encodeURIComponent(jobId)}`);
}

export function listProjects(): Promise<{
  data: Project[];
  projectRoot: string;
  allowOutsideProjectRoot?: boolean;
  systemDirectoryPickerAvailable?: boolean;
  threadContextFeatureEnabled?: boolean;
}> {
  return request("/api/projects");
}

export function createProject(input: {
  name: string;
  rootPath: string;
  createDirectory?: boolean;
  gitInit?: boolean;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  defaultSandbox?: SandboxMode;
  defaultApprovalPolicy?: ApprovalPolicy;
}): Promise<{ data: Project }> {
  return request("/api/projects", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function selectDirectory(): Promise<{ data: { rootPath: string } }> {
  return request("/api/system/select-directory", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function listDirectories(directoryPath?: string): Promise<{ data: DirectoryListResponse }> {
  const suffix = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : "";
  return request(`/api/system/directories${suffix}`);
}

export function updateProject(id: string, input: Partial<Project>): Promise<{ data: Project }> {
  return request(`/api/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${id}`, { method: "DELETE" });
}

export function listThreads(projectId: string, search?: string): Promise<ThreadListResponse> {
  const params = new URLSearchParams();
  params.set("fast", "true");
  if (search?.trim()) {
    params.set("search", search.trim());
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/projects/${projectId}/threads${suffix}`);
}

export function listArchivedThreads(projectId: string): Promise<ThreadListResponse> {
  return request(`/api/projects/${projectId}/threads?archived=true&fast=false`, { cache: "no-store" });
}

export function setThreadArchived(projectId: string, threadId: string, archived: boolean): Promise<{ ok: boolean }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/${archived ? "archive" : "unarchive"}`, { method: "POST", body: "{}" });
}

export function listProjectGitRepositories(projectId: string): Promise<{ data: Array<{ rootPath: string; name: string }> }> {
  return request(`/api/projects/${projectId}/git-repositories`);
}

export function createProjectWorktree(projectId: string, repositoryPath: string, name?: string): Promise<{ data: Project; branch: string; sourceProjectId: string; repositoryRoot: string }> {
  return request(`/api/projects/${projectId}/worktrees`, { method: "POST", body: JSON.stringify({ repositoryPath, name }) });
}

export function listProjectHooks(projectId: string, threadId?: string): Promise<{ data: {
  hooks: Array<{ key: string; currentHash: string | null; eventName: string; handlerType: string; source: string; pluginId: string | null; enabled: boolean; isManaged: boolean; trustStatus: string; matcher: string | null; trustable: boolean; command: string | null; userTrusted: boolean }>;
  warnings: string[]; errors: string[]
} }> {
  return request(`/api/projects/${projectId}/hooks${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`, { cache: "no-store" });
}

export function createProjectHook(projectId: string, input: { eventName: "SessionStart" | "Stop" | "PreToolUse" | "PostToolUse"; matcher?: string; command: string }): Promise<{ ok: boolean; path: string }> {
  return request(`/api/projects/${projectId}/hooks`, { method: "POST", body: JSON.stringify(input) });
}

export function setProjectHookTrust(projectId: string, threadId: string | undefined, key: string, currentHash: string, trusted: boolean): Promise<{ ok: boolean }> {
  return request(`/api/projects/${projectId}/hooks/trust${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`, {
    method: "POST", body: JSON.stringify({ key, currentHash, trusted })
  });
}

export function searchThreads(query: string, options: { offset?: number; signal?: AbortSignal } = {}): Promise<{
  data: ThreadSummary[]; total: number; nextOffset: number | null; indexing: boolean; pendingThreads?: number; generation: number; indexError?: string | null;
}> {
  const params = new URLSearchParams({ q: query, offset: String(options.offset ?? 0) });
  return request(`/api/search/threads?${params}`, { signal: options.signal });
}

export function searchThreadHits(threadId: string, projectId: string, query: string): Promise<{
  data: ThreadSearchMatch[]; total: number; indexing: boolean;
}> {
  const params = new URLSearchParams({ q: query, projectId });
  return request(`/api/search/threads/${encodeURIComponent(threadId)}/hits?${params}`, { cache: "no-store" });
}

export function deleteThread(projectId: string, threadId: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${projectId}/threads/${threadId}`, { method: "DELETE" });
}

export function branchThread(
  projectId: string,
  threadId: string,
  input: { turnId: string; prompt?: string; targetProjectId?: string }
): Promise<{ data: { thread: ThreadSummary; turn: { turn?: { id?: string } } | null; sourceThreadId: string; sourceTurnId: string; targetAccount?: { id: string; label: string } | null; branchMode: "native" | "cross-account-native" } }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/branch`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function startThreadReview(projectId: string, threadId: string, branch?: string): Promise<{ data: { turn: { id: string }; reviewThreadId: string } }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/review`, {
    method: "POST",
    body: JSON.stringify(branch ? { branch } : {})
  });
}

export function editLatestThreadTurn(projectId: string, threadId: string, turnId: string): Promise<{ data: unknown }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/edit-latest`, {
    method: "POST",
    body: JSON.stringify({ turnId })
  });
}

export function updateThreadPresentation(projectId: string, threadId: string, input: { pinned: boolean }): Promise<{ data: ThreadPresentation }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/presentation`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function readThreadContext(projectId: string, threadId: string): Promise<{ data: ThreadContextStatus }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/context`);
}

export function updateThreadContextPin(projectId: string, threadId: string, text: string): Promise<{ data: ThreadContextPin }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/context-pin`, {
    method: "PUT",
    body: JSON.stringify({ text })
  });
}

export function updateThreadContextConfig(
  projectId: string,
  threadId: string,
  input: {
    profile: ThreadContextProfile;
    contextWindow?: number | null;
    compactTokenLimit?: number | null;
    scope?: ThreadContextScope;
  }
): Promise<{ data: ThreadContextConfig }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/context-config`, {
    method: "PUT",
    body: JSON.stringify(input)
  });
}

export function updateThreadModelProfile(
  projectId: string,
  threadId: string,
  input: { model: string; reasoningEffort: ReasoningEffort }
): Promise<{ data: ThreadPresentation }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/model-profile`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function updateThreadOrder(projectId: string, threadIds: string[]): Promise<{ data: ThreadPresentation[] }> {
  return request(`/api/projects/${projectId}/threads/order`, {
    method: "PUT",
    body: JSON.stringify({ threadIds })
  });
}

export function readThread(threadId: string, projectId?: string, options?: { before?: number; cursor?: string; fresh?: boolean; limit?: number }): Promise<ThreadReadResponse> {
  const params = new URLSearchParams();
  if (projectId) {
    params.set("projectId", projectId);
  }
  if (typeof options?.before === "number") {
    params.set("before", String(Math.max(0, Math.floor(options.before))));
  }
  if (options?.cursor) {
    params.set("cursor", options.cursor);
  }
  if (options?.fresh) {
    params.set("fresh", "1");
  }
  if (typeof options?.limit === "number") {
    params.set("limit", String(Math.min(THREAD_READ_MAX_LIMIT, Math.max(1, Math.floor(options.limit)))));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/threads/${threadId}${suffix}`);
}

export function readThreadItemOutput(threadId: string, itemId: string, projectId?: string): Promise<{ data: { output: string; bytes: number } }> {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/threads/${encodeURIComponent(threadId)}/items/${encodeURIComponent(itemId)}/output${suffix}`);
}

export function locateThreadItem(threadId: string, itemId: string, projectId?: string): Promise<{ data: { ordinal: number; turnId: string; cursor: string } }> {
  const params = new URLSearchParams({ itemId });
  if (projectId) params.set("projectId", projectId);
  return request(`/api/threads/${encodeURIComponent(threadId)}/position?${params.toString()}`);
}

export function uploadProjectFiles(projectId: string, files: FileList | File[]): Promise<{ data: ProjectFile[] }> {
  const form = new FormData();
  for (const file of Array.from(files)) {
    form.append("files", file);
  }
  return request(`/api/projects/${projectId}/files/upload`, {
    method: "POST",
    body: form
  });
}

export function previewProjectFile(projectId: string, filePath: string): Promise<{ data: ProjectFilePreview }> {
  return request(`/api/projects/${projectId}/files/preview?path=${encodeURIComponent(filePath)}`);
}

export async function fetchProjectFileBlob(projectId: string, filePath: string): Promise<Blob> {
  const headers = new Headers();
  headers.set("x-codex-web-user-id", currentUserId);
  const response = await fetch(`/api/projects/${projectId}/files/raw?path=${encodeURIComponent(filePath)}`, { headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return response.blob();
}
