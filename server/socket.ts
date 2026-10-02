import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { serverConfig } from "./config.js";
import type { CodexBridge } from "./codexBridge.js";
import { isAccountPoolBridge } from "./accountPoolBridge.js";
import { authenticatedUserFromHeaders } from "./auth.js";
import { DEFAULT_USER_ID, type ProjectStore } from "./db.js";
import { LiveStateStore } from "./liveState.js";
import { notificationIsContextCompaction, RawCompactFilter } from "./rawNotificationFilter.js";
import { journalItem } from "./timelineJournal.js";
import { RequestDeduper } from "./requestDeduper.js";
import { getOwnedThreadGoal, setGoalAndStartIfIdle } from "./goalExecution.js";
import { documentContextInput, documentReferenceFromInput } from "./documentContext.js";
import {
  continuationRecoveryPrompt,
  contextRecoveryPrompt,
  isContextCompactionItem,
  isGenericContextLossReply,
  isPlanOnlyContinuationReply,
  isPotentialGenericContextLossReply
} from "./contextRecovery.js";
import { allowedAccountForUser, assertTrackedUserQuotaAvailable, invalidateTrackedQuotaCacheForUser } from "./routes.js";
import { findThreadJsonlPathById } from "./threadFallback.js";
import { scopedHookTrustConfig } from "./hookTrust.js";
import {
  contextPinDeveloperInstructions,
  contextWindowMeasuredForConfig,
  defaultThreadContextConfig,
  readThreadContextUsage,
  resolveThreadContextConfig,
  threadContextFeatureEnabled,
  threadContextConfigOverrides,
  threadTurnContextConfigOverrides
} from "./threadContext.js";
import type { Project, RpcEnvelope, SocketClientMessage, SocketServerMessage } from "./types.js";
import { sendUserPush } from "./webPush.js";
import { meaningfulTurnProgressMethod, TurnWatchdog, type WatchdogProbeClaim, type WatchdogTurn } from "./turnWatchdog.js";

const commandSchema = z.array(z.string()).min(1);
const threadStartContextConfigSchema = z.object({
  profile: z.enum(["default", "balanced", "long", "maximum", "custom"]),
  contextWindow: z.number().int().nullable().optional(),
  compactTokenLimit: z.number().int().nullable().optional(),
  scope: z.enum(["total", "body_after_prefix"]).nullable().optional()
}).strict();
const contextProbeBytes = 512 * 1024;
const contextPrecompactThreshold = 0.85;
const contextFullThreshold = 0.98;
const userWorkspaceRoot = process.env.CODEX_WEB_USER_WORKSPACE_ROOT ?? path.join(serverConfig.dataDir, "users");
const DEFAULT_COMPACT_TIMEOUT_MS = 600_000;

function compactTimeoutMs(): number {
  const raw = Number(process.env.CODEX_WEB_COMPACT_TIMEOUT_MS ?? DEFAULT_COMPACT_TIMEOUT_MS);
  if (!Number.isFinite(raw)) {
    return DEFAULT_COMPACT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.trunc(raw), 30_000), 1_800_000);
}

type UserWebSocket = WebSocket & {
  codexUserId?: string;
  /** Native WebSocket ping/pong detects half-open browser links without a page refresh. */
  isAlive?: boolean;
};

type SocketRequestGuards = {
  /** Request-id coalescing covers browser/network retries. */
  requestDeduper: RequestDeduper;
  /** A short content fingerprint window covers accidental distinct ids. */
  promptDeduper: RequestDeduper;
  /** A conversation can have only one accepted active generation. */
  activeTurnsByThread: Map<string, string>;
  /** Covers the narrow gap before app-server returns a turn id. */
  startingThreads: Set<string>;
  /** Turns created for a real user task, as opposed to maintenance compaction. */
  recoverableTurnIds: Set<string>;
};

function send(ws: WebSocket, message: SocketServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendToUser(wss: WebSocketServer, userId: string, message: SocketServerMessage): void {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    const userClient = client as UserWebSocket;
    if (client.readyState === client.OPEN && userClient.codexUserId === userId) {
      client.send(payload);
    }
  }
}

function broadcast(wss: WebSocketServer, message: SocketServerMessage): void {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

function textInput(prompt: string) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function skillNamesFromPrompt(prompt: string): string[] {
  const prefix = prompt.match(/^((?:\$[a-z][a-z0-9:_-]*(?:[ \t]+|\r?\n)?)+)/)?.[0] ?? "";
  return [...prefix.matchAll(/\$([a-z][a-z0-9:_-]*)/g)].map((match) => match[1]);
}

async function promptInput(bridge: CodexBridge, threadId: string, cwd: string, prompt: string, selected: unknown, documentReference?: unknown) {
  const context = documentContextInput(cwd, documentReference);
  if (!Array.isArray(selected) || selected.length === 0) return [...textInput(prompt), ...context];
  const names = [...new Set(selected)].filter((name): name is string => typeof name === "string" && /^[a-zA-Z0-9:_-]{1,120}$/.test(name)).slice(0, 8);
  if (names.length !== selected.length) throw new Error("技能选择无效，请重新选择后发送。");
  const targeted = bridge as CodexBridge & { requestOnThreadAccount?: (threadId: string, method: string, params: unknown) => Promise<unknown> };
  const result = targeted.requestOnThreadAccount
    ? await targeted.requestOnThreadAccount(threadId, "skills/list", { cwds: [cwd], forceReload: false })
    : await bridge.request("skills/list", { cwds: [cwd], forceReload: false });
  const groups = (result as { data?: Array<{ skills?: Array<{ name?: string; path?: string; enabled?: boolean }> }> }).data ?? [];
  const available = new Map(groups.flatMap((group) => group.skills ?? []).filter((skill) => skill.enabled && skill.path).map((skill) => [skill.name, skill.path]));
  const references = names.map((name) => {
    const path = available.get(name);
    if (!path) throw new Error(`技能 ${name} 在当前会话所属账号不可用，请刷新技能列表。`);
    return { type: "skill", name, path };
  });
  return [...textInput(prompt), ...references, ...context];
}

/**
 * Give a new conversation a useful label without opening another Codex turn.
 * The source question remains untouched; this only creates a compact display
 * name and is also written to the native Codex thread via thread/name/set.
 */
function titleFromFirstPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[[^\]]+\]\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[#>*\-\d.\s]+/, "")
    .trim();
  const firstClause = (cleaned.split(/[\r\n。！？!?；;]/, 1)[0] ?? cleaned).trim();
  const characters = Array.from(firstClause || cleaned);
  const limit = /[\u4e00-\u9fff]/.test(firstClause) ? 24 : 48;
  const title = characters.slice(0, limit).join("").trim().replace(/[，、,:：\-–—]+$/, "");
  return title || "新对话";
}

function sandboxPolicy(project: Project, mode = project.defaultSandbox) {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [project.rootPath],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
}

function pickString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function pickBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickSandbox(value: unknown, fallback: Project["defaultSandbox"]): Project["defaultSandbox"] {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return fallback;
}

function pickReasoningEffort(value: unknown, fallback: Project["defaultReasoningEffort"]): Project["defaultReasoningEffort"] {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra") {
    return value;
  }
  return fallback;
}

function requestedCollaborationMode(value: unknown, model: string, reasoningEffort: string) {
  if (value === undefined || value === "default") return undefined;
  if (value !== "plan") throw new Error("Invalid collaboration mode.");
  return { mode: "plan", settings: { model, reasoning_effort: reasoningEffort } };
}

function sessionUserIdFromHeaders(headers: Record<string, unknown> | IncomingHttpHeaders): string | null {
  const username = authenticatedUserFromHeaders(headers as any);
  if (!username) {
    return null;
  }
  if (username === "auth-disabled") {
    return DEFAULT_USER_ID;
  }
  return username.trim() || DEFAULT_USER_ID;
}

function safeUserWorkspaceSegment(value: string): string {
  const segment = value.normalize("NFC").replace(/[^\w.\-() \u4e00-\u9fff]/g, "_").replace(/^\.+$/, "");
  return segment || "user";
}

function isUserWorkspaceProject(project: Project, userId: string): boolean {
  return project.rootPath === path.join(userWorkspaceRoot, safeUserWorkspaceSegment(userId));
}

function getProjectOrThrow(store: ProjectStore, projectId: unknown, userId: string): Project {
  const id = pickString(projectId);
  const project = store.getProject(id, userId);
  if (!project) {
    throw new Error("Project not found.");
  }
  return project;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A resumed Codex thread can become permanently non-responsive when its saved
 * context reaches the model window: app-server accepts the turn, then records
 * zero input/output tokens and completes immediately. Read only the JSONL tail
 * to catch that state before accepting another user prompt.
 */
type ThreadContextCapacity = "healthy" | "nearLimit" | "exhausted";

async function threadContextCapacity(threadId: string): Promise<ThreadContextCapacity> {
  const filePath = await findThreadJsonlPathById(threadId);
  if (!filePath) {
    return "healthy";
  }
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const size = Math.min(stat.size, contextProbeBytes);
    if (!size) {
      return "healthy";
    }
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, Math.max(0, stat.size - size));
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index] ?? "") as { type?: unknown; payload?: Record<string, unknown> };
        if (record.type === "compacted" || (record.type === "event_msg" && record.payload?.type === "context_compacted")) {
          // A successful compaction is written after the high-water token event;
          // do not repeatedly compact the same already-compacted history.
          return "healthy";
        }
        if (record.type !== "event_msg" || record.payload?.type !== "token_count") {
          continue;
        }
        const info = asRecord(record.payload.info);
        const total = finiteNumber(asRecord(info.last_token_usage).total_tokens);
        const window = finiteNumber(info.model_context_window);
        if (total === null || window === null || window <= 0) {
          return "healthy";
        }
        const usage = total / window;
        if (usage >= contextFullThreshold) {
          return "exhausted";
        }
        return usage >= contextPrecompactThreshold ? "nearLimit" : "healthy";
      } catch {
        // The first line of the tail can be partial; keep scanning valid JSONL.
      }
    }
    return "healthy";
  } catch {
    return "healthy";
  } finally {
    await handle?.close();
  }
}

async function compactThreadAndWait(bridge: CodexBridge, threadId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let started = false;
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      bridge.off("notification", onNotification);
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onNotification = (event: RpcEnvelope) => {
      if (notificationThreadId(event) !== threadId) {
        return;
      }
      if (event.method === "turn/started") {
        started = true;
      }
      if (started && event.method === "turn/completed") {
        finish();
      }
    };

    bridge.on("notification", onNotification);
    const timeoutMs = compactTimeoutMs();
    timeout = setTimeout(() => finish(new Error("Timed out while compacting the Codex conversation.")), timeoutMs);
    void bridge.request("thread/compact/start", { threadId }, timeoutMs).catch((error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function notificationThreadId(envelope: RpcEnvelope): string | null {
  const params = asRecord(envelope.params);
  const turn = asRecord(params.turn);
  const thread = asRecord(params.thread);
  return stringOrNull(params.threadId) ?? stringOrNull(turn.threadId) ?? stringOrNull(thread.id) ?? null;
}

function notificationTurnId(envelope: RpcEnvelope): string | null {
  const params = asRecord(envelope.params);
  const turn = asRecord(params.turn);
  return stringOrNull(params.turnId) ?? stringOrNull(turn.id);
}

function notificationAccountId(envelope: RpcEnvelope): string | null {
  return stringOrNull(asRecord(envelope).accountId) ?? stringOrNull(asRecord(envelope.params).accountId);
}

function watchdogProgressData(turn: WatchdogTurn, state: string, probeStatus?: string) {
  return {
    threadId: turn.threadId,
    turnId: turn.turnId,
    state,
    phase: turn.phase,
    lastProgressAt: new Date(turn.lastProgressAt).toISOString(),
    lastProgressMethod: turn.lastProgressMethod,
    silentForMs: Math.max(0, Date.now() - turn.lastProgressAt),
    ...(probeStatus ? { probeStatus } : {}),
    ...(turn.activeFlags.length ? { activeFlags: turn.activeFlags } : {})
  };
}

function watchdogState(turn: WatchdogTurn): string {
  return turn.phase === "waiting_approval" || turn.phase === "waiting_subagents" ? turn.phase : "no_progress";
}

function changesFromTurnDiff(diff: string): Array<{ path: string; kind: string; diff: string }> {
  return diff.split(/(?=^diff --git )/m).filter((block) => block.trim()).map((block) => ({
    path: block.match(/^diff --git a\/.*? b\/(.+)$/m)?.[1]
      ?? block.match(/^\+\+\+ b\/(.+)$/m)?.[1]
      ?? "本轮变更",
    kind: "",
    diff: block
  }));
}

function notificationProcessId(envelope: RpcEnvelope): string | null {
  const params = asRecord(envelope.params);
  return stringOrNull(params.processId);
}

function assertThreadOwnedBy(
  store: ProjectStore,
  threadId: string,
  userId: string,
  projectId?: string,
  allowAnyOwnedProject = false
): void {
  if (!store.userCanAccessThread(threadId, userId, allowAnyOwnedProject ? undefined : projectId)) {
    throw new Error("Thread is not visible for this logged-in user.");
  }
}

function promptFingerprint(scope: string, prompt: string, model: string, effort: string): string {
  // Never retain the prompt itself in the dedupe cache.  The digest only lives
  // briefly in memory and lets separate browser events coalesce safely.
  return createHash("sha256").update(`${scope}\u0000${model}\u0000${effort}\u0000${prompt}`).digest("base64url");
}

function turnIdFromStartResult(value: unknown): string | null {
  const root = asRecord(value);
  const directTurn = asRecord(root.turn);
  return stringOrNull(directTurn.id)
    ?? stringOrNull(asRecord(directTurn.turn).id)
    ?? stringOrNull(asRecord(root.data).turnId)
    ?? stringOrNull(root.turnId);
}

function assertNoActiveTurn(guards: SocketRequestGuards, threadId: string): void {
  if (guards.startingThreads.has(threadId)) {
    throw new Error("This conversation is still starting. Please retry in a moment.");
  }
}

function rememberAcceptedTurn(guards: SocketRequestGuards, threadId: string, requestId: string, result: unknown): void {
  // `turn/started` will replace this placeholder with the canonical turn id.
  // Keeping a placeholder closes the race where a second prompt lands after
  // the RPC response but before the notification reaches this server.
  const turnId = turnIdFromStartResult(result);
  guards.activeTurnsByThread.set(threadId, turnId ?? `pending:${requestId}`);
  if (turnId) guards.recoverableTurnIds.add(turnId);
}

function runDedupedPrompt<T>(
  guards: SocketRequestGuards,
  userId: string,
  requestId: string,
  scope: string,
  prompt: string,
  model: string,
  effort: string,
  operation: () => Promise<T>
): Promise<T> {
  const fingerprint = promptFingerprint(scope, prompt, model, effort);
  return guards.promptDeduper.run(
    { userId, requestId: `prompt:${fingerprint}` },
    () => guards.requestDeduper.run({ userId, requestId }, operation),
    { serializeKey: scope }
  );
}

export function attachSocketServer(httpServer: HttpServer, bridge: CodexBridge, store: ProjectStore): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const liveStates = new Map<string, LiveStateStore>();
  const processOwners = new Map<string, string>();
  const processSockets = new Map<string, WebSocket>();
  const pendingApprovalOwners = new Map<number | string, string>();
  const pendingApprovalTurns = new Map<number | string, { userId: string; accountId: string | null; threadId: string; turnId: string | null }>();
  const turnOwners = new Map<string, string>();
  const rawCompactFilter = new RawCompactFilter();
  const contextRecoveryByTurn = new Map<string, { threadId: string; steerStatus: "pending" | "accepted" | "failed" }>();
  const contextRecoveryRetries = new Map<string, number>();
  const planContinuationByTurn = new Map<string, { rootTurnId: string; count: number }>();
  const guards: SocketRequestGuards = {
    requestDeduper: new RequestDeduper({ ttlMs: 30_000, maxEntries: 2_048 }),
    promptDeduper: new RequestDeduper({ ttlMs: 8_000, maxEntries: 2_048 }),
    activeTurnsByThread: new Map(),
    startingThreads: new Set(),
    recoverableTurnIds: new Set()
  };
  const turnWatchdog = new TurnWatchdog();
  const startingQueuedThreads = new Set<string>();
  const startNextQueuedTurn = async (owner: string, threadId: string): Promise<void> => {
    if (startingQueuedThreads.has(threadId) || guards.activeTurnsByThread.has(threadId) || guards.startingThreads.has(threadId)) return;
    startingQueuedThreads.add(threadId);
    try {
      const queued = await bridge.request("thread/queue/list", { threadId, limit: 1 }) as {
        data?: Array<{ id?: string }>;
      };
      const queuedSubmissionId = queued.data?.[0]?.id;
      if (!queuedSubmissionId || guards.activeTurnsByThread.has(threadId)) return;
      await assertTrackedUserQuotaAvailable(bridge, store, owner, threadId);
      const result = await bridge.request("thread/queue/start", { threadId, queuedSubmissionId });
      rememberAcceptedTurn(guards, threadId, `queued:${queuedSubmissionId}`, result);
      store.touchThreadOwner(threadId);
      sendToUser(wss, owner, { type: "turn.queue.started", data: { threadId, queuedSubmissionId } });
    } catch (error) {
      console.error("[thread.queue.start.error]", JSON.stringify({ threadId, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      startingQueuedThreads.delete(threadId);
    }
  };
  const steerQueuedSubmission = async (owner: string, threadId: string, expectedTurnId: string, queuedSubmissionId: string) => {
    if (startingQueuedThreads.has(threadId)) throw new Error("排队消息正在启动，请稍后重试。");
    startingQueuedThreads.add(threadId);
    try {
      const queued = await bridge.request("thread/queue/list", { threadId, limit: 100 }) as {
        data?: Array<{ id?: string; input?: Array<{ type?: string; text?: string }> }>;
      };
      const entry = queued.data?.find((item) => item.id === queuedSubmissionId);
      const prompt = entry?.input?.filter((part) => part.type === "text").map((part) => part.text ?? "").join(" ").trim();
      if (!prompt) throw new Error("排队消息已不存在或没有文字内容。");
      const result = await bridge.request("turn/steer", { threadId, expectedTurnId, input: entry?.input ?? textInput(prompt) });
      await bridge.request("thread/queue/delete", { threadId, queuedSubmissionId });
      store.touchThreadOwner(threadId);
      return result;
    } finally {
      startingQueuedThreads.delete(threadId);
      if (!guards.activeTurnsByThread.has(threadId)) setTimeout(() => void startNextQueuedTurn(owner, threadId), 0);
    }
  };

  const startFallbackContextRecovery = async (
    owner: string,
    threadId: string,
    priorTurnId: string,
    options?: { prompt?: string; plan?: { rootTurnId: string; count: number } }
  ): Promise<void> => {
    const retryCount = contextRecoveryRetries.get(threadId) ?? 0;
    if (retryCount >= 2 || guards.activeTurnsByThread.has(threadId)) return;
    const threadOwner = store.getThreadOwner(threadId);
    const project = threadOwner ? store.getProject(threadOwner.projectId, owner) : null;
    if (!threadOwner || !project) return;
    contextRecoveryRetries.set(threadId, retryCount + 1);
    try {
      await assertTrackedUserQuotaAvailable(bridge, store, owner, threadId);
      await bridge.request("thread/resume", {
        threadId,
        cwd: threadOwner.rootPath,
        model: threadOwner.modelOverride ?? project.defaultModel,
        approvalPolicy: project.defaultApprovalPolicy,
        sandbox: project.defaultSandbox
      }, 30_000);
      const requestId = `context-recovery:${priorTurnId}:${retryCount + 1}`;
      const turn = await bridge.request("turn/start", {
        threadId,
        input: textInput(options?.prompt ?? contextRecoveryPrompt()),
        cwd: threadOwner.rootPath,
        approvalPolicy: project.defaultApprovalPolicy,
        sandboxPolicy: sandboxPolicy(project, project.defaultSandbox),
        model: threadOwner.modelOverride ?? project.defaultModel,
        effort: threadOwner.reasoningEffortOverride ?? project.defaultReasoningEffort
      }, 30_000);
      rememberAcceptedTurn(guards, threadId, requestId, turn);
      if (options?.plan) {
        const newTurnId = turnIdFromStartResult(turn);
        if (newTurnId) {
          planContinuationByTurn.set(newTurnId, { rootTurnId: options.plan.rootTurnId, count: options.plan.count });
        }
      }
      store.touchThreadOwner(threadId);
    } catch (error) {
      console.error("[context.recovery.fallback.error]", JSON.stringify({
        owner,
        threadId,
        priorTurnId,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  };

  // Wi-Fi/ZeroTier can leave a browser TCP socket half-open: the tab still says
  // "open" but no reply or close event arrives. Probe every 15s and terminate
  // only sockets that miss a full ping interval so the client reconnects itself.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const userClient = client as UserWebSocket;
      if (userClient.isAlive === false) {
        client.terminate();
        continue;
      }
      userClient.isAlive = false;
      client.ping();
    }
  }, 15_000);
  wss.on("close", () => clearInterval(heartbeat));

  const liveStateFor = (userId: string): LiveStateStore => {
    let state = liveStates.get(userId);
    if (!state) {
      state = new LiveStateStore();
      liveStates.set(userId, state);
    }
    return state;
  };

  const sendTurnProgress = (turn: ReturnType<TurnWatchdog["start"]>, state: string, probeStatus?: string) => {
    sendToUser(wss, turn.userId, {
      type: "turn.progress",
      data: watchdogProgressData(turn, state, probeStatus)
    });
  };

  const ownerForEnvelope = (envelope: RpcEnvelope): string | null => {
    const threadId = notificationThreadId(envelope);
    if (threadId) {
      return store.getThreadOwner(threadId)?.userId ?? null;
    }
    const turnId = notificationTurnId(envelope);
    if (turnId) {
      const turnOwner = turnOwners.get(turnId);
      if (turnOwner) {
        return turnOwner;
      }
    }
    const processId = notificationProcessId(envelope);
    return processId ? processOwners.get(processId) ?? null : null;
  };

  const processBridgeNotification = (message: RpcEnvelope) => {
    const owner = ownerForEnvelope(message);
    if (!owner) {
      return;
    }

    const turnId = notificationTurnId(message);
    const threadIdForWatchdog = notificationThreadId(message);
    const accountId = notificationAccountId(message);
    if (turnId && threadIdForWatchdog && message.method === "turn/started") {
      turnWatchdog.start(owner, accountId, threadIdForWatchdog, turnId);
    }
    const progressMethod = meaningfulTurnProgressMethod(message);
    if (turnId && threadIdForWatchdog && progressMethod) {
      const progress = turnWatchdog.progress(owner, accountId, threadIdForWatchdog, turnId, progressMethod);
      if (progress?.resumed) sendTurnProgress(progress.turn, "active");
    }
    if (message.method === "turn/diff/updated" && turnId) {
      const threadId = notificationThreadId(message)
        ?? [...guards.activeTurnsByThread].find(([, activeTurnId]) => activeTurnId === turnId)?.[0];
      const diff = asRecord(message.params).diff;
      if (threadId && typeof diff === "string") {
        try {
          store.saveTimelineItem(threadId, turnId, {
            id: `turn-diff:${turnId}`,
            type: "fileChange",
            source: "turnDiff",
            changes: changesFromTurnDiff(diff),
            timelineAt: new Date().toISOString()
          });
        } catch (error) {
          console.warn("Could not persist turn diff", { threadId, turnId, error });
        }
      }
    }
    const state = liveStateFor(owner);
    const suppressRawCompact = rawCompactFilter.observe(message);
    const recordLiveState = !suppressRawCompact || notificationIsContextCompaction(message);
    const completingAgentMessages = turnId && message.method === "turn/completed"
      ? state.snapshot().agentMessages
        .filter((item) => item.turnId === turnId)
        .sort((left, right) => left.sequence - right.sequence)
      : [];
    if (turnId && message.method === "turn/started") {
      turnOwners.set(turnId, owner);
      const threadId = notificationThreadId(message);
      if (threadId) {
        guards.activeTurnsByThread.set(threadId, turnId);
      }
    }

    const liveUpdate = recordLiveState ? state.recordNotification(message) : null;
    if (liveUpdate?.kind === "tool" && liveUpdate.item.threadId && liveUpdate.item.turnId) {
      const label = liveUpdate.item.tool.toLowerCase();
      const phase = liveUpdate.item.completed
        ? "running"
        : label.includes("collab") || label.includes("agent") ? "waiting_subagents" : "tool_running";
      turnWatchdog.setPhase(owner, accountId, liveUpdate.item.threadId, liveUpdate.item.turnId, phase);
    }
    const recovery = turnId ? contextRecoveryByTurn.get(turnId) : undefined;
    const suppressGenericRecoveryMessage = Boolean(
      recovery
      && liveUpdate?.kind === "agent"
      && isPotentialGenericContextLossReply(liveUpdate.item.text)
    );
    const suppressInternalToolMessage = liveUpdate?.kind === "tool" && liveUpdate.item.internal;
    if (
      liveUpdate?.item.threadId
      && liveUpdate.item.turnId
      && !suppressGenericRecoveryMessage
      && !suppressInternalToolMessage
    ) {
      store.saveTimelineItem(liveUpdate.item.threadId, liveUpdate.item.turnId, journalItem(liveUpdate));
    }
    if (!suppressRawCompact) {
      sendToUser(wss, owner, { type: "codex.notification", data: message });
    }
    if (liveUpdate?.kind === "tool" && !suppressInternalToolMessage) {
      sendToUser(wss, owner, { type: "live.tool", data: liveUpdate.item });
    } else if (liveUpdate?.kind === "agent" && !suppressGenericRecoveryMessage) {
      sendToUser(wss, owner, { type: "live.agent", data: liveUpdate.item });
    }

    if (
      liveUpdate?.kind === "tool"
      && liveUpdate.item.threadId
      && liveUpdate.item.turnId
      && guards.recoverableTurnIds.has(liveUpdate.item.turnId)
      && isContextCompactionItem(liveUpdate.item)
      && !contextRecoveryByTurn.has(liveUpdate.item.turnId)
    ) {
      const attempt = { threadId: liveUpdate.item.threadId, steerStatus: "pending" as const };
      contextRecoveryByTurn.set(liveUpdate.item.turnId, attempt);
      void bridge.request("turn/steer", {
        threadId: liveUpdate.item.threadId,
        expectedTurnId: liveUpdate.item.turnId,
        input: textInput(contextRecoveryPrompt())
      }).then(() => {
        if (contextRecoveryByTurn.get(liveUpdate.item.turnId!) === attempt) {
          contextRecoveryByTurn.set(liveUpdate.item.turnId!, { ...attempt, steerStatus: "accepted" });
        }
      }).catch((error) => {
        if (contextRecoveryByTurn.get(liveUpdate.item.turnId!) === attempt) {
          contextRecoveryByTurn.set(liveUpdate.item.turnId!, { ...attempt, steerStatus: "failed" });
        }
        console.error("[context.recovery.steer.error]", JSON.stringify({
          threadId: liveUpdate.item.threadId,
          turnId: liveUpdate.item.turnId,
          error: error instanceof Error ? error.message : String(error)
        }));
      });
    }

    const maybe = message as { method?: string; params?: { processId?: string; deltaBase64?: string; stream?: string } };
    if (maybe.method === "command/exec/outputDelta" && maybe.params?.deltaBase64) {
      sendToUser(wss, owner, {
        type: "terminal.output",
        data: {
          processId: maybe.params.processId,
          stream: maybe.params.stream,
          text: Buffer.from(maybe.params.deltaBase64, "base64").toString("utf8")
        }
      });
    }

    if (turnId && message.method === "turn/completed") {
      const completedRecovery = contextRecoveryByTurn.get(turnId);
      const completedPlan = turnId ? planContinuationByTurn.get(turnId) : undefined;
      const latestAgent = completingAgentMessages.at(-1);
      const latestAgentText = latestAgent?.text ?? "";
      const needsFallbackRecovery = Boolean(completedRecovery && isGenericContextLossReply(latestAgentText));
      const completedThreadId = notificationThreadId(message);
      const completedItems = completedThreadId ? store.readTimelineItems(completedThreadId, turnId) : [];
      const latestAgentItem = [...completedItems].reverse().find((item) => item.type === "agentMessage");
      const latestAgentOrder = Number(latestAgentItem?.timelineOrder ?? latestAgent?.sequence);
      const hasToolAfterLatestAgent = Number.isFinite(latestAgentOrder)
        ? completedItems.some((item) => item.type === "toolCall" && Number(item.timelineOrder) > latestAgentOrder)
        : false;
      const nextPlanCount = (completedPlan?.count ?? 0) + 1;
      const needsPlanContinuation = nextPlanCount <= 2
        && isPlanOnlyContinuationReply(latestAgentText)
        && !hasToolAfterLatestAgent;
      const runtimeExited = asRecord(message.params).runtimeExited === true;
      const needsRecovery = !runtimeExited && (needsFallbackRecovery || needsPlanContinuation);
      if (completedThreadId) {
        for (const item of completedItems) {
          if (item.completed === false) store.saveTimelineItem(completedThreadId, turnId, { ...item, completed: true });
        }
      }
      invalidateTrackedQuotaCacheForUser(owner);
      turnOwners.delete(turnId);
      guards.recoverableTurnIds.delete(turnId);
      contextRecoveryByTurn.delete(turnId);
      planContinuationByTurn.delete(turnId);
      const threadId = notificationThreadId(message);
      if (threadId) {
        const activeTurn = guards.activeTurnsByThread.get(threadId);
        if (activeTurn === turnId || activeTurn?.startsWith("pending:")) {
          guards.activeTurnsByThread.delete(threadId);
        }
        if (runtimeExited) {
          contextRecoveryRetries.delete(threadId);
          setTimeout(() => void startNextQueuedTurn(owner, threadId), 0);
        } else if (needsRecovery) {
          setTimeout(() => void startFallbackContextRecovery(
            owner,
            threadId,
            turnId,
            needsFallbackRecovery
              ? undefined
              : {
                prompt: continuationRecoveryPrompt(),
                plan: { rootTurnId: completedPlan?.rootTurnId ?? turnId, count: nextPlanCount }
              }
          ), 0);
        } else if (completedRecovery || completedPlan) {
          contextRecoveryRetries.delete(threadId);
        } else {
          setTimeout(() => void startNextQueuedTurn(owner, threadId), 0);
        }
        const turnStatus = pickString(asRecord(asRecord(message.params).turn).status);
        const finishedWatchdogTurn = turnWatchdog.finish(owner, accountId, threadId, turnId);
        if (finishedWatchdogTurn) {
          const progressState = turnStatus === "failed" ? "failed" : turnStatus === "interrupted" ? "interrupted" : "completed";
          sendTurnProgress(finishedWatchdogTurn, progressState);
        }
        if (turnStatus === "completed" && !needsRecovery) {
          const threadOwner = store.getThreadOwner(threadId);
          void sendUserPush(store, owner, {
            type: "completed",
            threadId,
            projectId: threadOwner?.projectId,
            title: "Codex 已完成回答",
            body: "点开查看本轮结果"
          }).catch((error) => console.warn("Completion push failed", error));
        }
      }
    }
  };
  bridge.on("notification", processBridgeNotification);

  const runWatchdogProbe = async (claim: WatchdogProbeClaim): Promise<void> => {
    const turn = claim.turn;
    if (claim.shouldDiagnose) {
      const phase = turn.phase === "waiting_approval" || turn.phase === "waiting_subagents" ? turn.phase : "no_progress";
      console.warn("[turn.watchdog.no_progress]", JSON.stringify({
        userId: turn.userId,
        accountId: turn.accountId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        silentForMs: Math.max(0, Date.now() - turn.lastProgressAt),
        lastProgressMethod: turn.lastProgressMethod,
        phase
      }));
      sendTurnProgress(turn, phase);
    }
    try {
      if (!store.userCanAccessThread(turn.threadId, turn.userId)) {
        turnWatchdog.failProbe(turn.userId, turn.accountId, turn.threadId, turn.turnId, claim.token);
        return;
      }
      // AccountPoolBridge routes thread/read to the pinned account. This is a
      // bounded read-only observation and must never count as turn progress.
      const response = await bridge.request("thread/read", { threadId: turn.threadId, includeTurns: false }, 10_000);
      const thread = asRecord(asRecord(response).thread);
      const status = asRecord(thread.status);
      const statusName = pickString(status.type, "unknown");
      const flagsRaw = Array.isArray(status.activeFlags) ? status.activeFlags : [];
      const flags = flagsRaw.map((flag) => typeof flag === "string" ? flag : pickString(asRecord(flag).type ?? asRecord(flag).name ?? asRecord(flag).flag)).filter(Boolean);
      const resolved = turnWatchdog.resolveProbe(turn.userId, turn.accountId, turn.threadId, turn.turnId, claim.token, statusName, flags);
      if (!resolved) return; // A newer turn replaced this probe while it was in flight.
      const liveTurn = liveStateFor(turn.userId).snapshot().toolItems
        .find((item) => item.threadId === turn.threadId && item.turnId === turn.turnId && !item.completed);
      if (liveTurn && resolved.turn.phase === "running") {
        const label = liveTurn.tool.toLowerCase();
        turnWatchdog.setPhase(turn.userId, turn.accountId, turn.threadId, turn.turnId,
          label.includes("collab") || label.includes("agent") ? "waiting_subagents" : "tool_running");
      }
      if (resolved.changed) sendTurnProgress(turn, resolved.turn.phase, statusName);
    } catch (error) {
      const probeStillCurrent = turnWatchdog.failProbe(turn.userId, turn.accountId, turn.threadId, turn.turnId, claim.token);
      if (!probeStillCurrent) return;
      console.warn("[turn.watchdog.probe.error]", JSON.stringify({
        userId: turn.userId,
        accountId: turn.accountId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  };

  const watchdogInterval = setInterval(() => {
    for (const claim of turnWatchdog.claimDueProbes()) void runWatchdogProbe(claim);
  }, 15_000);
  watchdogInterval.unref?.();
  wss.on("close", () => clearInterval(watchdogInterval));

  bridge.on("serverRequest", (request) => {
    const owner = ownerForEnvelope(request as RpcEnvelope);
    if (owner) {
      if (request.id !== undefined && (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval")) {
        pendingApprovalOwners.set(request.id, owner);
        const threadId = notificationThreadId(request as RpcEnvelope);
        if (threadId) {
          const turnId = notificationTurnId(request as RpcEnvelope);
          const accountId = notificationAccountId(request as RpcEnvelope);
          pendingApprovalTurns.set(request.id, { userId: owner, accountId, threadId, turnId });
          turnWatchdog.setPhase(owner, accountId, threadId, turnId, "waiting_approval");
          void sendUserPush(store, owner, {
            type: "approval",
            threadId,
            projectId: store.getThreadOwner(threadId)?.projectId,
            title: "Codex 等待批准",
            body: "点开查看待批准的操作"
          }).catch((error) => console.warn("Approval push failed", error));
        }
      }
      sendToUser(wss, owner, { type: "codex.serverRequest", data: request });
    }
  });

  bridge.on("status", (status) => {
    const statusRecord = asRecord(status);
    if (statusRecord.state === "exited") {
      const accountId = stringOrNull(statusRecord.accountId);
      for (const turn of turnWatchdog.activeForAccount(accountId)) {
        for (const [requestId, approval] of pendingApprovalTurns) {
          if (approval.accountId === turn.accountId && approval.threadId === turn.threadId && approval.turnId === turn.turnId) {
            pendingApprovalTurns.delete(requestId);
            pendingApprovalOwners.delete(requestId);
          }
        }
        console.error("[turn.watchdog.runtime_exited]", JSON.stringify({
          userId: turn.userId,
          accountId: turn.accountId,
          threadId: turn.threadId,
          turnId: turn.turnId,
          code: typeof statusRecord.code === "number" ? statusRecord.code : undefined,
          signal: typeof statusRecord.signal === "string" ? statusRecord.signal : undefined
        }));
        // Reuse the regular completion path: it marks unfinished live tool
        // items complete, clears the active guard and advances queued work.
        processBridgeNotification({
          method: "turn/completed",
          accountId: turn.accountId,
          params: {
            threadId: turn.threadId,
            turnId: turn.turnId,
            turn: { id: turn.turnId, status: "interrupted" },
            runtimeExited: true
          }
        } as RpcEnvelope);
      }
    }
    broadcast(wss, { type: "codex.status", data: status });
  });

  wss.on("connection", (ws, request) => {
    const sessionUserId = sessionUserIdFromHeaders(request.headers as any);
    if (!sessionUserId) {
      ws.close(1008, "Authentication required.");
      return;
    }
    store.ensureUser(sessionUserId, sessionUserId);
    const userSocket = ws as UserWebSocket;
    userSocket.codexUserId = sessionUserId;
    userSocket.isAlive = true;
    ws.on("pong", () => {
      userSocket.isAlive = true;
    });

    send(ws, {
      type: "hello",
      ok: true,
      data: {
        pendingServerRequests: bridge.getPendingServerRequests().filter((pending) => pendingApprovalOwners.get(pending.id) === sessionUserId),
        liveState: liveStateFor(sessionUserId).snapshot(),
        turnProgress: turnWatchdog.diagnosedForUser(sessionUserId)
          .map((turn) => watchdogProgressData(turn, watchdogState(turn)))
      }
    });

    ws.on("message", (raw) => {
      void handleClientMessage(ws, bridge, rawCompactFilter, store, liveStateFor(sessionUserId), processOwners, processSockets, pendingApprovalOwners, pendingApprovalTurns, turnWatchdog, guards, sessionUserId, raw.toString("utf8"), startNextQueuedTurn, steerQueuedSubmission);
    });
    ws.on("close", () => {
      for (const [processId, socket] of processSockets) {
        if (socket !== ws) continue;
        processSockets.delete(processId);
        processOwners.delete(processId);
        void bridge.request("command/exec/terminate", { processId }, 10_000).catch(() => undefined);
      }
    });
  });

  return wss;
}

async function handleClientMessage(
  ws: WebSocket,
  bridge: CodexBridge,
  rawCompactFilter: RawCompactFilter,
  store: ProjectStore,
  liveState: LiveStateStore,
  processOwners: Map<string, string>,
  processSockets: Map<string, WebSocket>,
  pendingApprovalOwners: Map<number | string, string>,
  pendingApprovalTurns: Map<number | string, { userId: string; accountId: string | null; threadId: string; turnId: string | null }>,
  turnWatchdog: TurnWatchdog,
  guards: SocketRequestGuards,
  sessionUserId: string,
  raw: string,
  startNextQueuedTurn: (owner: string, threadId: string) => Promise<void>,
  steerQueuedSubmission: (owner: string, threadId: string, expectedTurnId: string, queuedSubmissionId: string) => Promise<unknown>
): Promise<void> {
  let message: SocketClientMessage;
  try {
    message = JSON.parse(raw) as SocketClientMessage;
  } catch {
    send(ws, { type: "error", ok: false, error: "Invalid JSON message." });
    return;
  }

  const requestId = message.requestId ?? randomUUID();
  try {
    switch (message.type) {
      case "live.state": {
        send(ws, { type: "live.state", requestId, ok: true, data: liveState.snapshot() });
        break;
      }

      case "thread.start": {
        await assertTrackedUserQuotaAvailable(bridge, store, sessionUserId);
        const project = getProjectOrThrow(store, message.projectId, sessionUserId);
        const prompt = pickString(message.prompt).trim();
        if (!prompt) {
          throw new Error("Prompt is required.");
        }
        const model = pickString(message.model, project.defaultModel).trim() || project.defaultModel;
        const reasoningEffort = pickReasoningEffort(message.reasoningEffort, project.defaultReasoningEffort);
        const requestedContextConfig = !threadContextFeatureEnabled || message.contextConfig === undefined
          ? null
          : resolveThreadContextConfig("", threadStartContextConfigSchema.parse(message.contextConfig));
        const requestedContextPin = threadContextFeatureEnabled
          ? pickString(message.contextPin).trim().slice(0, 16_000)
          : "";
        const data = await runDedupedPrompt(
          guards,
          sessionUserId,
          requestId,
          `new-thread:${project.id}`,
          prompt,
          model,
          reasoningEffort,
          async () => {
            const startParams = {
              cwd: project.rootPath,
              model,
              approvalPolicy: pickString(message.approvalPolicy, project.defaultApprovalPolicy),
              sandbox: pickString(message.sandbox, project.defaultSandbox),
              threadSource: "user",
              config: {
                ...threadContextConfigOverrides(requestedContextConfig),
                ...await scopedHookTrustConfig(bridge, store, sessionUserId, project)
              },
              developerInstructions: contextPinDeveloperInstructions(requestedContextPin)
            };
            const allowedAccountId = allowedAccountForUser(sessionUserId);
            const thread = allowedAccountId && isAccountPoolBridge(bridge)
              ? await bridge.startThreadOnAccount(allowedAccountId, startParams)
              : await bridge.request("thread/start", startParams);
            const threadId = (thread as { thread?: { id?: string } }).thread?.id;
            if (!threadId) {
              throw new Error("Codex did not return a thread id.");
            }
            store.registerThreadOwner({
              threadId,
              userId: sessionUserId,
              projectId: project.id,
              rootPath: project.rootPath,
              model,
              reasoningEffort
            });
            if (requestedContextConfig) {
              store.setThreadContextConfig(threadId, sessionUserId, {
                profile: requestedContextConfig.profile,
                contextWindow: requestedContextConfig.contextWindow,
                compactTokenLimit: requestedContextConfig.compactTokenLimit,
                scope: requestedContextConfig.scope
              });
            }
            if (requestedContextPin) {
              store.setThreadContextPin(threadId, sessionUserId, requestedContextPin);
            }
            const autoTitle = titleFromFirstPrompt(prompt);
            store.updateThreadDisplayName(threadId, sessionUserId, autoTitle);
            const createdThread = (thread as { thread?: { name?: string; title?: string } }).thread;
            if (createdThread) {
              createdThread.name = autoTitle;
              createdThread.title = autoTitle;
            }
            // Native title persistence must never delay the first answer.
            void bridge.request("thread/name/set", { threadId, name: autoTitle }).catch((error) => {
              console.warn("Native Codex automatic thread title failed", error);
            });
            const turn = await bridge.request("turn/start", {
              threadId,
              input: await promptInput(bridge, threadId, project.rootPath, prompt, message.skillNames, message.documentReference),
              collaborationMode: requestedCollaborationMode(message.collaborationMode, model, reasoningEffort),
              cwd: project.rootPath,
              approvalPolicy: pickString(message.approvalPolicy, project.defaultApprovalPolicy),
              sandboxPolicy: sandboxPolicy(project, pickSandbox(message.sandbox, project.defaultSandbox)),
              model,
              effort: reasoningEffort,
              config: {
                ...threadTurnContextConfigOverrides(requestedContextConfig),
                ...await scopedHookTrustConfig(bridge, store, sessionUserId, project, threadId)
              }
            });
            rememberAcceptedTurn(guards, threadId, requestId, turn);
            store.touchThreadOwner(threadId);
            return { thread, turn };
          }
        );
        send(ws, { type: "ack", requestId, ok: true, data });
        break;
      }

      case "turn.start": {
        await assertTrackedUserQuotaAvailable(bridge, store, sessionUserId, pickString(message.threadId));
        const project = getProjectOrThrow(store, message.projectId, sessionUserId);
        const threadId = pickString(message.threadId);
        const prompt = pickString(message.prompt).trim();
        if (!threadId || !prompt) {
          throw new Error("threadId and prompt are required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId, project.id, isUserWorkspaceProject(project, sessionUserId));
        const owner = store.getThreadOwner(threadId);
        const ownerProject = owner ? store.getProject(owner.projectId, sessionUserId) : null;
        const modelDefaults = ownerProject ?? project;
        const model = owner?.modelOverride ?? modelDefaults.defaultModel;
        const reasoningEffort = owner?.reasoningEffortOverride ?? modelDefaults.defaultReasoningEffort;
        const data = await runDedupedPrompt(
          guards,
          sessionUserId,
          requestId,
          `thread:${threadId}`,
          prompt,
          model,
          reasoningEffort,
          async () => {
            assertNoActiveTurn(guards, threadId);
            guards.startingThreads.add(threadId);
            try {
              const contextConfig = store.getThreadContextConfig(threadId, sessionUserId)
                ?? defaultThreadContextConfig(threadId);
              const contextUsage = await readThreadContextUsage(threadId, contextConfig);
              await bridge.request("thread/resume", {
                threadId,
                cwd: project.rootPath,
                model,
                approvalPolicy: pickString(message.approvalPolicy, project.defaultApprovalPolicy),
                sandbox: pickString(message.sandbox, project.defaultSandbox),
                config: {
                  ...threadContextConfigOverrides(contextConfig, contextWindowMeasuredForConfig(contextConfig, contextUsage)),
                  ...await scopedHookTrustConfig(bridge, store, sessionUserId, project, threadId)
                },
                developerInstructions: threadContextFeatureEnabled
                  ? contextPinDeveloperInstructions(store.getThreadContextPin(threadId, sessionUserId)?.text ?? "")
                  : undefined
              }, 30_000);
              const turn = await bridge.request("turn/start", {
                threadId,
                input: await promptInput(bridge, threadId, project.rootPath, prompt, message.skillNames, message.documentReference),
                collaborationMode: requestedCollaborationMode(message.collaborationMode, model, reasoningEffort),
                cwd: project.rootPath,
                approvalPolicy: pickString(message.approvalPolicy, project.defaultApprovalPolicy),
                sandboxPolicy: sandboxPolicy(project, pickSandbox(message.sandbox, project.defaultSandbox)),
                model,
                effort: reasoningEffort,
                config: {
                  ...threadTurnContextConfigOverrides(contextConfig, contextWindowMeasuredForConfig(contextConfig, contextUsage)),
                  ...await scopedHookTrustConfig(bridge, store, sessionUserId, project, threadId)
                }
              }, 30_000);
              rememberAcceptedTurn(guards, threadId, requestId, turn);
              if (!owner?.modelOverride || !owner.reasoningEffortOverride) {
                store.setThreadModelConfig(threadId, sessionUserId, model, reasoningEffort);
              }
              store.touchThreadOwner(threadId);
              return { turn };
            } finally {
              guards.startingThreads.delete(threadId);
            }
          }
        );
        send(ws, { type: "ack", requestId, ok: true, data });
        break;
      }

      case "turn.steer": {
        await assertTrackedUserQuotaAvailable(bridge, store, sessionUserId, pickString(message.threadId));
        const threadId = pickString(message.threadId);
        const expectedTurnId = pickString(message.expectedTurnId);
        const prompt = pickString(message.prompt).trim();
        if (!threadId || !expectedTurnId || !prompt) {
          throw new Error("threadId, expectedTurnId, and prompt are required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const result = await runDedupedPrompt(
          guards,
          sessionUserId,
          requestId,
          `steer:${threadId}`,
          prompt,
          "steer",
          "",
          async () => {
            const value = await bridge.request("turn/steer", {
              threadId,
              expectedTurnId,
              input: await promptInput(bridge, threadId, store.getThreadOwner(threadId)?.rootPath ?? "", prompt, message.skillNames, message.documentReference)
            });
            store.touchThreadOwner(threadId);
            return value;
          }
        );
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "turn.queue.add": {
        await assertTrackedUserQuotaAvailable(bridge, store, sessionUserId, pickString(message.threadId));
        const threadId = pickString(message.threadId);
        const prompt = pickString(message.prompt).trim();
        if (!threadId || !prompt) throw new Error("threadId and prompt are required.");
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const result = await guards.requestDeduper.run(
          { userId: sessionUserId, requestId },
          async () => bridge.request("thread/queue/add", { threadId, input: await promptInput(bridge, threadId, store.getThreadOwner(threadId)?.rootPath ?? "", prompt, message.skillNames, message.documentReference), clientUserMessageId: requestId }),
          { serializeKey: `queue:${threadId}` }
        );
        send(ws, { type: "ack", requestId, ok: true, data: result });
        setTimeout(() => void startNextQueuedTurn(sessionUserId, threadId), 0);
        break;
      }

      case "turn.queue.list": {
        const threadId = pickString(message.threadId);
        if (!threadId) throw new Error("threadId is required.");
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const result = await bridge.request("thread/queue/list", { threadId, limit: 100 });
        send(ws, { type: "ack", requestId, ok: true, data: { threadId, ...asRecord(result) } });
        break;
      }

      case "turn.queue.delete": {
        const threadId = pickString(message.threadId);
        const queuedSubmissionId = pickString(message.queuedSubmissionId);
        if (!threadId || !queuedSubmissionId) throw new Error("threadId and queuedSubmissionId are required.");
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const result = await bridge.request("thread/queue/delete", { threadId, queuedSubmissionId });
        send(ws, { type: "ack", requestId, ok: true, data: { threadId, ...asRecord(result) } });
        break;
      }

      case "turn.queue.update": {
        const threadId = pickString(message.threadId);
        const queuedSubmissionId = pickString(message.queuedSubmissionId);
        const prompt = pickString(message.prompt).trim();
        if (!threadId || !queuedSubmissionId || !prompt) throw new Error("threadId, queuedSubmissionId and prompt are required.");
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const skillNames = Array.isArray(message.skillNames) ? message.skillNames : skillNamesFromPrompt(prompt);
        const skillPrefix = Array.isArray(message.skillNames) ? prompt.match(/^((?:\$[a-z][a-z0-9:_-]*(?:[ \t]+|\r?\n)?)+)/)?.[0] ?? "" : "";
        const promptBody = skillPrefix && skillNamesFromPrompt(skillPrefix).every((name) => skillNames.includes(name))
          ? prompt.slice(skillPrefix.length).trimStart()
          : prompt;
        const queuedState = asRecord(await bridge.request("thread/queue/list", { threadId, limit: 100 }));
        const queuedItems = Array.isArray(queuedState.data) ? queuedState.data.map(asRecord) : [];
        const queuedItem = queuedItems.find((item) => item.id === queuedSubmissionId);
        if (!queuedItem) throw new Error("排队中的消息暂时无法读取，请刷新队列后重试编辑。");
        const documentReference = documentReferenceFromInput(queuedItem?.input);
        const result = await bridge.request("thread/queue/update", { threadId, queuedSubmissionId, input: await promptInput(bridge, threadId, store.getThreadOwner(threadId)?.rootPath ?? "", promptBody, skillNames, documentReference) });
        send(ws, { type: "ack", requestId, ok: true, data: { threadId, ...asRecord(result) } });
        break;
      }

      case "turn.queue.steer": {
        await assertTrackedUserQuotaAvailable(bridge, store, sessionUserId, pickString(message.threadId));
        const threadId = pickString(message.threadId);
        const expectedTurnId = pickString(message.expectedTurnId);
        const queuedSubmissionId = pickString(message.queuedSubmissionId);
        if (!threadId || !expectedTurnId || !queuedSubmissionId) throw new Error("threadId, expectedTurnId and queuedSubmissionId are required.");
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const result = await guards.requestDeduper.run(
          { userId: sessionUserId, requestId },
          () => steerQueuedSubmission(sessionUserId, threadId, expectedTurnId, queuedSubmissionId),
          { serializeKey: `queue:${threadId}` }
        );
        send(ws, { type: "ack", requestId, ok: true, data: { threadId, ...asRecord(result) } });
        break;
      }

      case "turn.interrupt": {
        const threadId = pickString(message.threadId);
        const turnId = pickString(message.turnId);
        if (!threadId || !turnId) {
          throw new Error("threadId and turnId are required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const result = await guards.requestDeduper.run(
          { userId: sessionUserId, requestId },
          async () => {
            let goalPaused = false;
            try {
              const goalResponse = await bridge.request("thread/goal/get", { threadId }) as {
                goal?: { status?: string } | null;
              };
              if (goalResponse.goal?.status === "active") {
                await bridge.request("thread/goal/set", { threadId, status: "paused" });
                goalPaused = true;
              }
            } catch {
              // Goal support is optional. A goal lookup failure must never stop
              // the user from interrupting the currently running turn.
            }
            const interrupt = await bridge.request("turn/interrupt", { threadId, turnId });
            return { interrupt, goalPaused };
          },
          { serializeKey: `thread:${threadId}` }
        );
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "goal.clear": {
        const threadId = pickString(message.threadId);
        if (!threadId) {
          throw new Error("threadId is required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const result = await guards.requestDeduper.run(
          { userId: sessionUserId, requestId },
          async () => {
            const activeTurnId = guards.activeTurnsByThread.get(threadId);
            if (activeTurnId && !activeTurnId.startsWith("pending:")) {
              try {
                await bridge.request("turn/interrupt", { threadId, turnId: activeTurnId });
              } catch {
                // Clearing the goal is the safety-critical action. Continue if
                // the turn already completed before the interrupt arrived.
              }
            }
            return bridge.request("thread/goal/clear", { threadId });
          },
          { serializeKey: `thread:${threadId}` }
        );
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "goal.get": {
        const threadId = pickString(message.threadId);
        if (!threadId) throw new Error("threadId is required.");
        const data = await getOwnedThreadGoal({ bridge, store, userId: sessionUserId, threadId });
        send(ws, { type: "ack", requestId, ok: true, data });
        break;
      }

      case "goal.set": {
        const threadId = pickString(message.threadId);
        const objective = typeof message.objective === "string" ? message.objective.trim() : undefined;
        if (!threadId || (objective !== undefined && !objective)) {
          throw new Error("threadId is required, and objective must not be empty when provided.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const status = pickString(message.status, "active");
        if (status === "active") await assertTrackedUserQuotaAvailable(bridge, store, sessionUserId, threadId);
        if (status !== "active" && status !== "paused" && status !== "blocked" && status !== "usageLimited" && status !== "budgetLimited" && status !== "complete") {
          throw new Error("Invalid Goal status.");
        }
        const tokenBudget = typeof message.tokenBudget === "number" && Number.isInteger(message.tokenBudget)
          ? message.tokenBudget
          : null;
        const data = await guards.requestDeduper.run(
          { userId: sessionUserId, requestId },
          () => setGoalAndStartIfIdle({
            bridge,
            store,
            registry: guards,
            userId: sessionUserId,
            threadId,
            objective,
            status,
            tokenBudget,
            requestId,
            rememberAcceptedTurn: (acceptedThreadId, acceptedRequestId, result) => rememberAcceptedTurn(guards, acceptedThreadId, acceptedRequestId, result)
          }),
          { serializeKey: `thread:${threadId}` }
        );
        send(ws, { type: "ack", requestId, ok: true, data: { threadId, ...asRecord(data) } });
        break;
      }

      case "thread.compact": {
        await assertTrackedUserQuotaAvailable(bridge, store, sessionUserId, pickString(message.threadId));
        const project = getProjectOrThrow(store, message.projectId, sessionUserId);
        const threadId = pickString(message.threadId);
        if (!threadId) {
          throw new Error("threadId is required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId, project.id, isUserWorkspaceProject(project, sessionUserId));
        const result = await guards.requestDeduper.run(
          { userId: sessionUserId, requestId },
          async () => {
            rawCompactFilter.markRequested(threadId);
            try {
              const value = await bridge.request("thread/compact/start", { threadId }, compactTimeoutMs());
              store.touchThreadOwner(threadId);
              return value;
            } catch (error) {
              rawCompactFilter.clear(threadId);
              throw error;
            }
          },
          { serializeKey: `thread:${threadId}` }
        );
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "thread.rename": {
        const project = getProjectOrThrow(store, message.projectId, sessionUserId);
        const threadId = pickString(message.threadId);
        const name = pickString(message.name).trim();
        if (!threadId || !name) {
          throw new Error("threadId and name are required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId, project.id, isUserWorkspaceProject(project, sessionUserId));
        // Persist the web title first; the bridge routes the native Codex
        // update to this thread's pinned account in the background.
        const result = store.updateThreadDisplayName(threadId, sessionUserId, name);
        if (!result) {
          throw new Error("Thread presentation could not be updated.");
        }
        store.touchThreadOwner(threadId);
        send(ws, { type: "ack", requestId, ok: true, data: result });
        void bridge.request("thread/name/set", { threadId, name }).catch((error) => {
          console.warn("Native Codex thread rename failed after local title was saved", error);
        });
        break;
      }

      case "thread.shellCommand": {
        const project = getProjectOrThrow(store, message.projectId, sessionUserId);
        const threadId = pickString(message.threadId);
        const command = pickString(message.command).trim();
        if (!threadId || !command) {
          throw new Error("threadId and command are required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId, project.id, isUserWorkspaceProject(project, sessionUserId));
        const result = await bridge.request("thread/shellCommand", { threadId, command }, 180_000);
        store.touchThreadOwner(threadId);
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "command.exec": {
        const project = getProjectOrThrow(store, message.projectId, sessionUserId);
        const command = commandSchema.parse(message.command);
        const processId = pickString(message.processId, `cmd-${randomUUID()}`);
        const tty = pickBoolean(message.tty, true);
        const disableTimeout = pickBoolean(message.disableTimeout, false);
        processOwners.set(processId, sessionUserId);
        processSockets.set(processId, ws);
        let result: unknown;
        try { result = await bridge.request(
          "command/exec",
          {
            command,
            processId,
            tty,
            streamStdin: true,
            streamStdoutStderr: true,
            disableTimeout,
            timeoutMs: disableTimeout ? undefined : 120_000,
            // A browser must not override its owned project's filesystem boundary.
            cwd: project.rootPath,
            ...(tty ? { size: message.size ?? { cols: 100, rows: 28 } } : {}),
            sandboxPolicy: sandboxPolicy(project, pickSandbox(message.sandbox, project.defaultSandbox))
          },
          disableTimeout ? 86_400_000 : 180_000
        ); } finally {
          processOwners.delete(processId);
          processSockets.delete(processId);
        }
        send(ws, { type: "ack", requestId, ok: true, data: { processId, result } });
        break;
      }

      case "command.write": {
        const processId = pickString(message.processId);
        const data = pickString(message.data);
        if (!processId) {
          throw new Error("processId is required.");
        }
        if (processOwners.get(processId) !== sessionUserId) {
          throw new Error("Process is not visible for this logged-in user.");
        }
        const result = await bridge.request("command/exec/write", { processId, deltaBase64: Buffer.from(data, "utf8").toString("base64") });
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "command.resize": {
        const processId = pickString(message.processId);
        if (!processId || processOwners.get(processId) !== sessionUserId) {
          throw new Error("Process is not visible for this logged-in user.");
        }
        const size = message.size as { cols?: unknown; rows?: unknown } | undefined;
        const cols = Number(size?.cols);
        const rows = Number(size?.rows);
        if (!Number.isInteger(cols) || cols < 20 || cols > 400 || !Number.isInteger(rows) || rows < 5 || rows > 200) {
          throw new Error("Invalid terminal size.");
        }
        const result = await bridge.request("command/exec/resize", { processId, size: { cols, rows } });
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "command.terminate": {
        const processId = pickString(message.processId);
        if (!processId) {
          throw new Error("processId is required.");
        }
        if (processOwners.get(processId) !== sessionUserId) {
          throw new Error("Process is not visible for this logged-in user.");
        }
        const result = await bridge.request("command/exec/terminate", { processId });
        processOwners.delete(processId);
        processSockets.delete(processId);
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "approval.respond": {
        const responseId = message.codexRequestId as number | string | undefined;
        if (responseId === undefined) {
          throw new Error("codexRequestId is required.");
        }
        if (pendingApprovalOwners.get(responseId) !== sessionUserId) {
          throw new Error("This approval does not belong to the logged-in user.");
        }
        bridge.respondToServerRequest(responseId, message.result);
        pendingApprovalOwners.delete(responseId);
        const approvalTurn = pendingApprovalTurns.get(responseId);
        pendingApprovalTurns.delete(responseId);
        if (approvalTurn) {
          turnWatchdog.setPhase(approvalTurn.userId, approvalTurn.accountId, approvalTurn.threadId, approvalTurn.turnId, "running");
        }
        send(ws, { type: "ack", requestId, ok: true });
        break;
      }

      default:
        throw new Error(`Unsupported socket message type: ${message.type}`);
    }
  } catch (error) {
    console.error("[socket.ack.error]", JSON.stringify({
      userId: sessionUserId,
      type: message.type,
      requestId,
      threadId: message.threadId,
      error: error instanceof Error ? error.message : String(error)
    }));
    send(ws, {
      type: "ack",
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
