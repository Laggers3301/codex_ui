import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { CodexBridge } from "./codexBridge.js";
import { isAccountPoolBridge } from "./accountPoolBridge.js";
import { serverConfig } from "./config.js";
import { authenticatedUserFromHeaders } from "./auth.js";
import { DEFAULT_USER_ID, type ProjectStore } from "./db.js";
import { LiveStateStore } from "./liveState.js";
import { journalItem } from "./timelineJournal.js";
import { RequestDeduper } from "./requestDeduper.js";
import {
  contextRecoveryPrompt,
  isContextCompactionItem,
  isGenericContextLossReply,
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

async function promptInput(bridge: CodexBridge, threadId: string, cwd: string, prompt: string, selected: unknown) {
  if (!Array.isArray(selected) || selected.length === 0) return textInput(prompt);
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
  return [...textInput(prompt), ...references];
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
    timeout = setTimeout(() => finish(new Error("Timed out while compacting the Codex conversation.")), 180_000);
    void bridge.request("thread/compact/start", { threadId }, 180_000).catch((error) => {
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
  const turnOwners = new Map<string, string>();
  const contextRecoveryByTurn = new Map<string, { threadId: string; steerStatus: "pending" | "accepted" | "failed" }>();
  const contextRecoveryRetries = new Map<string, number>();
  const guards: SocketRequestGuards = {
    requestDeduper: new RequestDeduper({ ttlMs: 30_000, maxEntries: 2_048 }),
    promptDeduper: new RequestDeduper({ ttlMs: 8_000, maxEntries: 2_048 }),
    activeTurnsByThread: new Map(),
    startingThreads: new Set(),
    recoverableTurnIds: new Set()
  };
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

  const startFallbackContextRecovery = async (owner: string, threadId: string, priorTurnId: string): Promise<void> => {
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
        input: textInput(contextRecoveryPrompt()),
        cwd: threadOwner.rootPath,
        approvalPolicy: project.defaultApprovalPolicy,
        sandboxPolicy: sandboxPolicy(project, project.defaultSandbox),
        model: threadOwner.modelOverride ?? project.defaultModel,
        effort: threadOwner.reasoningEffortOverride ?? project.defaultReasoningEffort
      }, 30_000);
      rememberAcceptedTurn(guards, threadId, requestId, turn);
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

  bridge.on("notification", (message) => {
    const owner = ownerForEnvelope(message);
    if (!owner) {
      return;
    }

    const turnId = notificationTurnId(message);
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

    const liveUpdate = state.recordNotification(message);
    const recovery = turnId ? contextRecoveryByTurn.get(turnId) : undefined;
    const suppressGenericRecoveryMessage = Boolean(
      recovery
      && liveUpdate?.kind === "agent"
      && isPotentialGenericContextLossReply(liveUpdate.item.text)
    );
    if (liveUpdate?.item.threadId && liveUpdate.item.turnId && !suppressGenericRecoveryMessage) {
      store.saveTimelineItem(liveUpdate.item.threadId, liveUpdate.item.turnId, journalItem(liveUpdate));
    }
    sendToUser(wss, owner, { type: "codex.notification", data: message });
    if (liveUpdate?.kind === "tool") {
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
      const latestAgentText = completingAgentMessages.at(-1)?.text ?? "";
      const needsFallbackRecovery = Boolean(completedRecovery && isGenericContextLossReply(latestAgentText));
      const completedThreadId = notificationThreadId(message);
      if (completedThreadId) {
        for (const item of store.readTimelineItems(completedThreadId, turnId)) {
          if (item.completed === false) store.saveTimelineItem(completedThreadId, turnId, { ...item, completed: true });
        }
      }
      invalidateTrackedQuotaCacheForUser(owner);
      turnOwners.delete(turnId);
      guards.recoverableTurnIds.delete(turnId);
      contextRecoveryByTurn.delete(turnId);
      const threadId = notificationThreadId(message);
      if (threadId) {
        const activeTurn = guards.activeTurnsByThread.get(threadId);
        if (activeTurn === turnId || activeTurn?.startsWith("pending:")) {
          guards.activeTurnsByThread.delete(threadId);
        }
        if (needsFallbackRecovery) {
          setTimeout(() => void startFallbackContextRecovery(owner, threadId, turnId), 0);
        } else if (completedRecovery) {
          contextRecoveryRetries.delete(threadId);
        } else {
          setTimeout(() => void startNextQueuedTurn(owner, threadId), 0);
        }
        const turnStatus = pickString(asRecord(asRecord(message.params).turn).status);
        if (turnStatus === "completed" && !needsFallbackRecovery) {
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
  });

  bridge.on("serverRequest", (request) => {
    const owner = ownerForEnvelope(request as RpcEnvelope);
    if (owner) {
      if (request.id !== undefined && (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval")) {
        pendingApprovalOwners.set(request.id, owner);
        const threadId = notificationThreadId(request as RpcEnvelope);
        if (threadId) {
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
        liveState: liveStateFor(sessionUserId).snapshot()
      }
    });

    ws.on("message", (raw) => {
      void handleClientMessage(ws, bridge, store, liveStateFor(sessionUserId), processOwners, processSockets, pendingApprovalOwners, guards, sessionUserId, raw.toString("utf8"), startNextQueuedTurn, steerQueuedSubmission);
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
  store: ProjectStore,
  liveState: LiveStateStore,
  processOwners: Map<string, string>,
  processSockets: Map<string, WebSocket>,
  pendingApprovalOwners: Map<number | string, string>,
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
              input: await promptInput(bridge, threadId, project.rootPath, prompt, message.skillNames),
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
                input: await promptInput(bridge, threadId, project.rootPath, prompt, message.skillNames),
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
              input: await promptInput(bridge, threadId, store.getThreadOwner(threadId)?.rootPath ?? "", prompt, message.skillNames)
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
          async () => bridge.request("thread/queue/add", { threadId, input: await promptInput(bridge, threadId, store.getThreadOwner(threadId)?.rootPath ?? "", prompt, message.skillNames), clientUserMessageId: requestId }),
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
        const result = await bridge.request("thread/queue/update", { threadId, queuedSubmissionId, input: await promptInput(bridge, threadId, store.getThreadOwner(threadId)?.rootPath ?? "", promptBody, skillNames) });
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

      case "goal.set": {
        await assertTrackedUserQuotaAvailable(bridge, store, sessionUserId, pickString(message.threadId));
        const threadId = pickString(message.threadId);
        const objective = pickString(message.objective).trim();
        if (!threadId || !objective) {
          throw new Error("threadId and objective are required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const status = pickString(message.status, "active");
        if (status !== "active" && status !== "paused" && status !== "blocked" && status !== "usageLimited" && status !== "budgetLimited" && status !== "complete") {
          throw new Error("Invalid Goal status.");
        }
        const tokenBudget = typeof message.tokenBudget === "number" && Number.isInteger(message.tokenBudget)
          ? message.tokenBudget
          : null;
        const data = await guards.requestDeduper.run(
          { userId: sessionUserId, requestId },
          async () => {
            const goal = await bridge.request("thread/goal/set", { threadId, objective, status, tokenBudget });
            if (status !== "active" || guards.activeTurnsByThread.has(threadId)) {
              return goal;
            }

            // Setting a goal on an idle thread persists the native objective but
            // does not always create the first turn. Kick off one explicitly;
            // if the native goal manager won the race, its active-turn error is
            // harmless and the goal remains active for subsequent continuation.
            const owner = store.getThreadOwner(threadId);
            const project = owner ? store.getProject(owner.projectId, sessionUserId) : null;
            if (!owner || !project) {
              return goal;
            }
            try {
              await bridge.request("thread/resume", {
                threadId,
                cwd: owner.rootPath,
                model: owner.modelOverride ?? project.defaultModel,
                approvalPolicy: project.defaultApprovalPolicy,
                sandbox: project.defaultSandbox
              }, 30_000);
              const turn = await bridge.request("turn/start", {
                threadId,
                input: textInput("请立即开始执行当前 Goal，并持续工作直到目标完成。"),
                cwd: owner.rootPath,
                approvalPolicy: project.defaultApprovalPolicy,
                sandboxPolicy: sandboxPolicy(project, project.defaultSandbox),
                model: owner.modelOverride ?? project.defaultModel,
                effort: owner.reasoningEffortOverride ?? project.defaultReasoningEffort
              }, 30_000);
              rememberAcceptedTurn(guards, threadId, requestId, turn);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!/active turn|turn.*already|goal continuation/i.test(message)) {
                throw error;
              }
            }
            return goal;
          },
          { serializeKey: `thread:${threadId}` }
        );
        send(ws, { type: "ack", requestId, ok: true, data });
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
            const value = await bridge.request("thread/compact/start", { threadId }, 180_000);
            store.touchThreadOwner(threadId);
            return value;
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
