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
  SideChat,
  SubagentThreadSummary,
  ThreadSummary,
  ThreadSearchMatch,
  TrackedQuotaUsage,
  UserProfile
} from "./types";

const defaultUserId = "admin";
export function readHostResources(signal: AbortSignal): Promise<{ data: import("../shared/hostResources").HostResources }> {
  return request("/api/system/resources", { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
}
export function pingHostNetwork(signal: AbortSignal): Promise<{ data: import("../shared/hostResources").HostNetworkProbeResult }> {
  return request("/api/system/network/ping", { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) });
}
export function readCommunication(threadId: string, signal?: AbortSignal): Promise<{ data: import("../shared/sessionCommunication").CommunicationSnapshot }> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/communication`, { signal });
}
export function readCommunicationTargets(threadId: string, query: string, signal: AbortSignal): Promise<{ data: import("../shared/sessionTasks").SessionTaskTarget[] }> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/communication/targets?query=${encodeURIComponent(query)}`, { signal, cache: "no-store" });
}
export function sendCommunication(threadId: string, command: import("../shared/sessionCommunication").CommunicationCommand): Promise<{ data: Record<string, unknown> }> {
  return request(`/api/threads/${encodeURIComponent(threadId)}/communication`, { method: "POST", body: JSON.stringify(command), signal: AbortSignal.timeout(15000) });
}
export const THREAD_READ_MAX_LIMIT = 240;

let currentUserId = localStorage.getItem("codex-web-user-id") || defaultUserId;

export function setApiUserId(userId: string): void {
  currentUserId = userId || defaultUserId;
  localStorage.setItem("codex-web-user-id", currentUserId);
}

export function getApiUserId(): string {
  return currentUserId;
}

export type SpeechResult = { text: string; model: string; timingId?: string; serverTimings?: { totalMs: number; uploadMs: number; workerMs: number } };
export function transcribeSpeech(audio: Blob, signal: AbortSignal, recorderFinalizeMs = 0): Promise<SpeechResult> {
  const form = new FormData();
  form.append("audio", audio, "recording");
  return request("/api/speech/transcribe", { method: "POST", body: form, signal, headers: { "x-speech-finalize-ms": String(Math.round(recorderFinalizeMs)) } });
}

export function createSpeechPreupload(mime: string) {
  const controller = new AbortController();
  let cancelled = false, failed = false, count = 0, acknowledged = 0;
  const pending: Promise<void>[] = [];
  const tail: Blob[] = [];
  let combinedTail = false;
  // Two bounded lanes tolerate out-of-order network completion. Server joins
  // original chunk indices, not arrival order; MP4/WebM fragments stay intact.
  const lanes = [Promise.resolve(), Promise.resolve()];
  // Let creation finish after cancel so its ID can be deleted. Aborting before
  // learning the ID could leave a ghost owner session until TTL expiration.
  const ready = request<{ id: string; combinedTail?: boolean }>("/api/speech/uploads", { method: "POST", body: JSON.stringify({ mime }), signal: AbortSignal.timeout(15000) })
    .then(result => { combinedTail = result.combinedTail === true; if (cancelled || failed) void remove(result.id); return result.id; })
    .catch(() => { failed = true; return null; });
  const remove = async (id: string) => { try { await request(`/api/speech/uploads/${id}`, { method: "DELETE", keepalive: true }); } catch { /* TTL is the final cleanup guard. */ } };
  return {
    get bytes() { return acknowledged; },
    add(blob: Blob, final = false) {
      if (cancelled || failed || !blob.size) return;
      if (final) { tail.push(blob); return; }
      const index = count++, lane = index % 2;
      const task = lanes[lane].then(async () => {
        const id = await ready;
        if (!id || cancelled || failed) return;
        const form = new FormData(); form.append("audio", blob, "fragment");
        await request(`/api/speech/uploads/${id}/${index}`, { method: "POST", body: form, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        acknowledged += blob.size;
      }).catch(() => { failed = true; });
      lanes[lane] = task; pending.push(task);
    },
    async finish(audio: Blob, signal: AbortSignal, finalizeMs: number) {
      const waitStarted = performance.now();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      let id: string | null = null;
      let deadline = 0;
      try {
        // A lost/slow fragment must not make dictation wait for the entire
        // 15-second upload timeout. No recognition has started at this point,
        // so uploading the complete recording is a safe single-inference fallback.
        await Promise.race([
          (async () => {
            id = await ready;
            if (!combinedTail) for (const blob of tail) this.add(blob);
            await Promise.all(pending);
          })(),
          new Promise<void>(resolve => { deadline = window.setTimeout(() => { failed = true; controller.abort(); resolve(); }, 2000); }),
        ]);
      } finally { window.clearTimeout(deadline); signal.removeEventListener("abort", abort); }
      if (signal.aborted || cancelled) throw new DOMException("录音已取消", "AbortError");
      const pendingUploadMs = performance.now() - waitStarted;
      const requestStarted = performance.now();
      let body: BodyInit = JSON.stringify({ parts: count });
      if (combinedTail && tail.length) {
        const form = new FormData();
        form.append("parts", String(count));
        form.append("audio", new Blob(tail, { type: mime }), "tail");
        body = form;
      }
      // Only fall back BEFORE invoking recognition, never retry a completed
      // model request (which could consume GPU twice or duplicate dictation).
      const result = failed || !id
        ? await (async () => { if (id) void remove(id); return transcribeSpeech(audio, signal, finalizeMs); })()
        : await request<SpeechResult>(`/api/speech/uploads/${id}/complete`, {
          method: "POST", body, signal,
          headers: { "x-speech-finalize-ms": String(Math.round(finalizeMs)) },
        });
      return { result, pendingUploadMs, requestMs: performance.now() - requestStarted };
    },
    cancel() { cancelled = true; controller.abort(); void ready.then(id => { if (id) return remove(id); }); },
  };
}

export function reportSpeechTiming(timings: Record<string, number | string | undefined>): void {
  if (!timings.timingId) return;
  // Numeric telemetry only; never attach audio, transcript, cookies or tokens.
  void request("/api/speech/timing", { method: "POST", body: JSON.stringify(timings), keepalive: true }).catch(() => {});
}

export interface UiUpdatesState {
  version: string;
  hasUnseen: boolean;
  notice?: string;
}

export function readUiUpdates(userId: string, signal?: AbortSignal, target = "account"): Promise<UiUpdatesState> {
  return request(`/api/ui-updates?target=${encodeURIComponent(target)}`, { cache: "no-store", signal, headers: { "x-codex-web-user-id": userId } });
}

export function markUiUpdatesSeen(userId: string, version: string, signal?: AbortSignal, target = "account"): Promise<UiUpdatesState> {
  return request("/api/ui-updates/seen", { method: "POST", body: JSON.stringify({ version, target }), signal, headers: { "x-codex-web-user-id": userId } });
}

export interface PetRecord {
  id: string;
  name: string;
  version: 1 | 2;
  spritesheetUrl: string;
  thumbnailUrl?: string;
  format?: "png" | "webp";
  createdAt?: string;
  size?: number;
  laughSpritesheetUrl?: string;
  [key: string]: unknown;
}

export interface PetPreferences {
  pets: PetRecord[];
  prefs?: { activePetId: string | null; visible: boolean; position: { x: number; y: number } | null };
  activePetId: string | null;
  visible: boolean;
  position: { x: number; y: number } | null;
}

export function listPets(signal?: AbortSignal): Promise<PetPreferences> {
  return request("/api/pets", { cache: "no-store", signal });
}

export type PetPreferenceResponse = Partial<Pick<PetPreferences, "activePetId" | "visible" | "position">> & {
  prefs?: Partial<Pick<PetPreferences, "activePetId" | "visible" | "position">>;
};

export function patchPetPreferences(patch: Partial<Pick<PetPreferences, "activePetId" | "visible" | "position">>, signal?: AbortSignal): Promise<PetPreferenceResponse> {
  return request("/api/pets/prefs", { method: "PATCH", body: JSON.stringify(patch), signal });
}

export function uploadPetAtlas(file: File, name: string, signal?: AbortSignal): Promise<{ pet: PetRecord }> {
  const body = new FormData();
  body.append("file", file);
  body.append("name", name);
  return request("/api/pets", { method: "POST", body, signal });
}

export interface RemoteFolder {
  id: string;
  name: string;
  host: string;
  remotePath: string;
  mountPath: string;
  readOnly: boolean;
  scope: "conversation" | "account";
}

export interface RemoteFolderEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "other";
}

async function remoteFolderRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const expectedUserId = currentUserId;
  const result = await request<T & { ownerUserId: string }>(path, { ...options, cache: "no-store" });
  if (currentUserId !== expectedUserId || result.ownerUserId !== expectedUserId) {
    throw new Error("远程目录的账号与当前页面不一致，请刷新网页后重试。");
  }
  return result;
}

export function listRemoteFolders(threadId: string | null, signal?: AbortSignal): Promise<{ data: RemoteFolder[]; workspacePath: string }> {
  const params = new URLSearchParams();
  if (threadId) params.set("threadId", threadId);
  return remoteFolderRequest(`/api/remote-folders?${params}`, { signal });
}

export function createWorkspaceDirectory(parentPath: string, name: string): Promise<{ data: { path: string } }> {
  return request("/api/system/directories", { method: "POST", body: JSON.stringify({ parentPath, name }) });
}

export function listRemoteFolderEntries(id: string, relativePath: string, threadId: string | null, signal?: AbortSignal): Promise<{ data: { entries: RemoteFolderEntry[]; truncated: boolean } }> {
  const params = new URLSearchParams({ path: relativePath });
  if (threadId) params.set("threadId", threadId);
  return remoteFolderRequest(`/api/remote-folders/${encodeURIComponent(id)}/entries?${params}`, { signal });
}

export interface RemoteFolderCatalog {
  hosts: Array<{ id: string; name: string; windows: boolean }>;
  recent: Array<{ id: string; name: string; hostId: string; path: string }>;
}

export interface RemoteDirectoryPage {
  path: string | null;
  displayPath: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
  truncated: boolean;
}

export function remoteFolderCatalog(signal?: AbortSignal): Promise<{ data: RemoteFolderCatalog }> {
  return remoteFolderRequest("/api/remote-folders/catalog", { signal });
}

export function browseRemoteComputer(hostId: string, path: string | null, signal?: AbortSignal): Promise<{ data: RemoteDirectoryPage }> {
  return remoteFolderRequest("/api/remote-folders/browse", { method: "POST", body: JSON.stringify({ hostId, path }), signal });
}

export function attachRemoteFolder(threadId: string, hostId: string, path: string, signal?: AbortSignal): Promise<{ data: { id: string } }> {
  return remoteFolderRequest("/api/remote-folders/attach", { method: "POST", body: JSON.stringify({ threadId, hostId, path }), signal });
}

export function closeRemoteFolder(threadId: string, folderId: string): Promise<{ data: { ok: boolean } }> {
  return remoteFolderRequest(`/api/remote-folders/${encodeURIComponent(folderId)}/close`, { method: "POST", body: JSON.stringify({ threadId }) });
}

export function reconnectRemoteFolder(threadId: string, folderId: string, signal?: AbortSignal): Promise<{ data: { id: string } }> {
  return remoteFolderRequest(`/api/remote-folders/${encodeURIComponent(folderId)}/reconnect`, { method: "POST", body: JSON.stringify({ threadId }), signal });
}

export function transferRemoteFolderDraft(draftId: string, threadId: string): Promise<{ data: { ok: boolean } }> {
  return remoteFolderRequest("/api/remote-folders/transfer", { method: "POST", body: JSON.stringify({ draftId, threadId }) });
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
  if (!headers.has("x-codex-web-user-id")) headers.set("x-codex-web-user-id", currentUserId);
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

export function requestComposerPrediction(projectId:string,threadId:string,sourceTurnId:string,modelKey:string,signal:AbortSignal):Promise<{data:{text:string|null;sourceTurnId:string;eligible:boolean}}> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/prediction`,{
    method:"POST",body:JSON.stringify({sourceTurnId,modelKey}),signal,
  });
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
  toolNames: string[];
}

export function readThreadMcpStatus(projectId: string, threadId: string, signal?: AbortSignal): Promise<{
  data: McpServerSummary[];
  nextCursor: string | null;
  sharedRuntimeWarning: string;
}> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/mcp-status`, { cache: "no-store", signal });
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

export function listArchivedThreads(projectId: string, signal?:AbortSignal): Promise<ThreadListResponse & {archiveIndexIncomplete?:boolean}> {
  return request(`/api/projects/${projectId}/threads?archived=true&fast=false`, { cache: "no-store",
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(7000)]):AbortSignal.timeout(7000) });
}

function subagentUrl(projectId: string, parentThreadId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(parentThreadId)}/subagents`;
}

export function listSubagentThreads(projectId: string, parentThreadId: string, signal?: AbortSignal, options: { view?: "all" | "active" | "history"; q?: string; cursor?: string; limit?: number } = {}): Promise<import("./types").SubagentDirectoryResponse> {
  const params = new URLSearchParams();
  if (options.view) params.set("view", options.view);
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  return request(subagentUrl(projectId, parentThreadId) + (params.size ? `?${params}` : ""), { cache: "no-store", signal });
}

export function readSubagentThread(projectId: string, parentThreadId: string, agentId: string, options: { before?: number; beforeCursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<ThreadReadResponse> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 128) });
  if (options.beforeCursor) params.set("cursor", options.beforeCursor);
  else if (options.before) params.set("before", String(options.before));
  return request(`${subagentUrl(projectId, parentThreadId)}/${encodeURIComponent(agentId)}?${params}`, { cache: "no-store", signal: options.signal });
}

export function readSubagentItemOutput(projectId: string, parentThreadId: string, agentId: string, itemId: string): Promise<{ data: { output: string } }> {
  return request(`${subagentUrl(projectId, parentThreadId)}/${encodeURIComponent(agentId)}/items/${encodeURIComponent(itemId)}/output`, { cache: "no-store" });
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

const sideChatUrl = (projectId: string, parentThreadId: string) => `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(parentThreadId)}/side-chat`;

export function readSideChat(projectId: string, parentThreadId: string): Promise<{ data: SideChat | null }> {
  return request(sideChatUrl(projectId, parentThreadId), { cache: "no-store" });
}

export function createSideChat(projectId: string, parentThreadId: string, selectedText: string, modelProfileId: string): Promise<{ data: SideChat }> {
  return request(sideChatUrl(projectId, parentThreadId), { method: "POST", body: JSON.stringify({ selectedText, modelProfileId }) });
}

export function saveSideChatDraft(side: SideChat, draft: string, modelProfileId: string, keepalive = false): Promise<{ data: SideChat }> {
  return request(sideChatUrl(side.projectId, side.parentThreadId), { method: "PATCH", body: JSON.stringify({ id: side.id, draft, modelProfileId, expectedRequestId: side.requestId }), keepalive });
}

export function deleteSideChat(side: SideChat): Promise<{ ok: boolean; data: SideChat | null }> {
  return request(`${sideChatUrl(side.projectId, side.parentThreadId)}?id=${encodeURIComponent(side.id)}`, { method: "DELETE" });
}

export function branchThread(
  projectId: string,
  threadId: string,
  input: { turnId: string; prompt?: string; targetProjectId?: string; archiveToolOutputs?:boolean }
): Promise<{ data: { thread: ThreadSummary; turn: { turn?: { id?: string } } | null; sourceThreadId: string; sourceTurnId: string; targetAccount?: { id: string; label: string } | null; branchMode: "native" | "cross-account-native" | "legacy-stream-import" | "legacy-tool-archive" } }> {
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

export function editLatestThreadTurn(projectId: string, threadId: string, turnId: string, edit?: { expectedLatestTurnId: string; allowHistoryRewrite: boolean }): Promise<{ data: unknown }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/edit-latest`, {
    method: "POST",
    body: JSON.stringify({ turnId, ...edit })
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

export function readThreadExecutionSettings(projectId: string, threadId: string): Promise<{ data: { sandbox: SandboxMode; approvalPolicy: ApprovalPolicy } | null }> {
  return request(`/api/projects/${projectId}/threads/${threadId}/execution-settings`);
}

export function updateThreadExecutionSettings(projectId: string, threadId: string, input: { sandbox: SandboxMode; approvalPolicy: ApprovalPolicy }) {
  return request(`/api/projects/${projectId}/threads/${threadId}/execution-settings`, { method: "PATCH", body: JSON.stringify(input) });
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
