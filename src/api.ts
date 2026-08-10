import type {
  ApprovalPolicy,
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
  Project,
  ProjectFile,
  ProjectFilePreview,
  ReasoningEffort,
  SandboxMode,
  SessionMigrationResult,
  ThreadPresentation,
  ThreadListResponse,
  ThreadReadResponse,
  UserProfile
} from "./types";

const defaultUserId = "admin";

let currentUserId = localStorage.getItem("codex-web-user-id") || defaultUserId;

export function setApiUserId(userId: string): void {
  currentUserId = userId || defaultUserId;
  localStorage.setItem("codex-web-user-id", currentUserId);
}

export function getApiUserId(): string {
  return currentUserId;
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

export function readCodexLeaderboard(refresh = false): Promise<{ data: CodexLeaderboard }> {
  const suffix = refresh ? "?refresh=true" : "";
  return request(`/api/codex/leaderboard${suffix}`, { cache: "no-store" });
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
    method: "POST"
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

export function migrateSessionsFrom4090(): Promise<{ data: SessionMigrationResult; message?: string }> {
  return request("/api/handoff/from-4090-left", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function listProjects(): Promise<{
  data: Project[];
  projectRoot: string;
  allowOutsideProjectRoot?: boolean;
  systemDirectoryPickerAvailable?: boolean;
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

export function deleteThread(projectId: string, threadId: string): Promise<{ ok: boolean }> {
  return request(`/api/projects/${projectId}/threads/${threadId}`, { method: "DELETE" });
}

export function updateThreadPresentation(projectId: string, threadId: string, input: { pinned: boolean }): Promise<{ data: ThreadPresentation }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/presentation`, {
    method: "PATCH",
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

export function readThread(threadId: string, projectId?: string, options?: { before?: number; limit?: number }): Promise<ThreadReadResponse> {
  const params = new URLSearchParams();
  if (projectId) {
    params.set("projectId", projectId);
  }
  if (typeof options?.before === "number") {
    params.set("before", String(Math.max(0, Math.floor(options.before))));
  }
  if (typeof options?.limit === "number") {
    params.set("limit", String(Math.max(1, Math.floor(options.limit))));
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request(`/api/threads/${threadId}${suffix}`);
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
