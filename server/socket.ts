import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { CodexBridge } from "./codexBridge.js";
import { authenticatedUserFromHeaders } from "./auth.js";
import { serverConfig } from "./config.js";
import { DEFAULT_USER_ID, type ProjectStore } from "./db.js";
import { LiveStateStore } from "./liveState.js";
import { findThreadJsonlPathById } from "./threadFallback.js";
import type { Project, RpcEnvelope, SocketClientMessage, SocketServerMessage } from "./types.js";

const commandSchema = z.array(z.string()).min(1);
const contextProbeBytes = 512 * 1024;
const contextPrecompactThreshold = 0.85;
const contextFullThreshold = 0.98;
const userWorkspaceRoot = process.env.CODEX_WEB_USER_WORKSPACE_ROOT ?? path.join(serverConfig.projectRoot, "users");

type UserWebSocket = WebSocket & {
  codexUserId?: string;
  /** Native WebSocket ping/pong detects half-open browser links without a page refresh. */
  isAlive?: boolean;
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
        const total = finiteNumber(asRecord(info.total_token_usage).total_tokens);
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
  return stringOrNull(params.threadId) ?? stringOrNull(thread.id) ?? null;
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

export function attachSocketServer(httpServer: HttpServer, bridge: CodexBridge, store: ProjectStore): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const liveStates = new Map<string, LiveStateStore>();
  const processOwners = new Map<string, string>();

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
    const processId = notificationProcessId(envelope);
    return processId ? processOwners.get(processId) ?? null : null;
  };

  bridge.on("notification", (message) => {
    const owner = ownerForEnvelope(message);
    if (!owner) {
      return;
    }

    liveStateFor(owner).recordNotification(message);
    sendToUser(wss, owner, { type: "codex.notification", data: message });

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
  });

  bridge.on("serverRequest", (request) => {
    const owner = ownerForEnvelope(request as RpcEnvelope);
    if (owner) {
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
        pendingServerRequests: [],
        liveState: liveStateFor(sessionUserId).snapshot()
      }
    });

    ws.on("message", (raw) => {
      void handleClientMessage(ws, bridge, store, liveStateFor(sessionUserId), processOwners, sessionUserId, raw.toString("utf8"));
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
  sessionUserId: string,
  raw: string
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
        const project = getProjectOrThrow(store, message.projectId, sessionUserId);
        const prompt = pickString(message.prompt).trim();
        if (!prompt) {
          throw new Error("Prompt is required.");
        }
        const thread = await bridge.request("thread/start", {
          cwd: project.rootPath,
          model: pickString(message.model, project.defaultModel) || null,
          approvalPolicy: pickString(message.approvalPolicy, project.defaultApprovalPolicy),
          sandbox: pickString(message.sandbox, project.defaultSandbox),
          threadSource: "user"
        });
        const threadId = (thread as { thread?: { id?: string } }).thread?.id;
        if (!threadId) {
          throw new Error("Codex did not return a thread id.");
        }
        store.registerThreadOwner({ threadId, userId: sessionUserId, projectId: project.id, rootPath: project.rootPath });
        const turn = await bridge.request("turn/start", {
          threadId,
          input: textInput(prompt),
          cwd: project.rootPath,
          approvalPolicy: pickString(message.approvalPolicy, project.defaultApprovalPolicy),
          sandboxPolicy: sandboxPolicy(project, pickSandbox(message.sandbox, project.defaultSandbox)),
          model: pickString(message.model, project.defaultModel) || null,
          effort: pickReasoningEffort(message.reasoningEffort, project.defaultReasoningEffort)
        });
        store.touchThreadOwner(threadId);
        send(ws, { type: "ack", requestId, ok: true, data: { thread, turn } });
        break;
      }

      case "turn.start": {
        const project = getProjectOrThrow(store, message.projectId, sessionUserId);
        const threadId = pickString(message.threadId);
        const prompt = pickString(message.prompt).trim();
        if (!threadId || !prompt) {
          throw new Error("threadId and prompt are required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId, project.id, isUserWorkspaceProject(project, sessionUserId));
        // `total_token_usage` in session telemetry is not a reliable current
        // context occupancy signal after compaction/resume. Do not block a user
        // turn based on that estimate: app-server remains the source of truth.
        await bridge.request("thread/resume", {
          threadId,
          cwd: project.rootPath,
          model: pickString(message.model, project.defaultModel) || null,
          approvalPolicy: pickString(message.approvalPolicy, project.defaultApprovalPolicy),
          sandbox: pickString(message.sandbox, project.defaultSandbox)
        });
        const turn = await bridge.request("turn/start", {
          threadId,
          input: textInput(prompt),
          cwd: project.rootPath,
          approvalPolicy: pickString(message.approvalPolicy, project.defaultApprovalPolicy),
          sandboxPolicy: sandboxPolicy(project, pickSandbox(message.sandbox, project.defaultSandbox)),
          model: pickString(message.model, project.defaultModel) || null,
          effort: pickReasoningEffort(message.reasoningEffort, project.defaultReasoningEffort)
        });
        store.touchThreadOwner(threadId);
        send(ws, { type: "ack", requestId, ok: true, data: { turn } });
        break;
      }

      case "turn.steer": {
        const threadId = pickString(message.threadId);
        const expectedTurnId = pickString(message.expectedTurnId);
        const prompt = pickString(message.prompt).trim();
        if (!threadId || !expectedTurnId || !prompt) {
          throw new Error("threadId, expectedTurnId, and prompt are required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const result = await bridge.request("turn/steer", {
          threadId,
          expectedTurnId,
          input: textInput(prompt)
        });
        store.touchThreadOwner(threadId);
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "turn.interrupt": {
        const threadId = pickString(message.threadId);
        const turnId = pickString(message.turnId);
        if (!threadId || !turnId) {
          throw new Error("threadId and turnId are required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId);
        const result = await bridge.request("turn/interrupt", { threadId, turnId });
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "thread.compact": {
        const project = getProjectOrThrow(store, message.projectId, sessionUserId);
        const threadId = pickString(message.threadId);
        if (!threadId) {
          throw new Error("threadId is required.");
        }
        assertThreadOwnedBy(store, threadId, sessionUserId, project.id, isUserWorkspaceProject(project, sessionUserId));
        const result = await bridge.request("thread/compact/start", { threadId }, 180_000);
        store.touchThreadOwner(threadId);
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
        const result = await bridge.request("thread/name/set", { threadId, name });
        store.touchThreadOwner(threadId);
        send(ws, { type: "ack", requestId, ok: true, data: result });
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
        const result = await bridge.request(
          "command/exec",
          {
            command,
            processId,
            tty,
            streamStdin: true,
            streamStdoutStderr: true,
            disableTimeout,
            timeoutMs: disableTimeout ? undefined : 120_000,
            cwd: pickString(message.cwd, project.rootPath),
            ...(tty ? { size: message.size ?? { cols: 100, rows: 28 } } : {}),
            sandboxPolicy: sandboxPolicy(project, pickSandbox(message.sandbox, project.defaultSandbox))
          },
          disableTimeout ? 86_400_000 : 180_000
        );
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
        send(ws, { type: "ack", requestId, ok: true, data: result });
        break;
      }

      case "approval.respond": {
        const responseId = message.codexRequestId as number | string | undefined;
        if (responseId === undefined) {
          throw new Error("codexRequestId is required.");
        }
        bridge.respondToServerRequest(responseId, message.result);
        send(ws, { type: "ack", requestId, ok: true });
        break;
      }

      default:
        throw new Error(`Unsupported socket message type: ${message.type}`);
    }
  } catch (error) {
    send(ws, {
      type: "ack",
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
