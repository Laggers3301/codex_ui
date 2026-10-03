import type { ProjectStore } from "./db.js";
import { browserMcpForThread } from "./browserRoutes.js";

export interface GoalBridge { request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>; }
export type GoalStore = Pick<ProjectStore, "getThreadOwner" | "getProject" | "userCanAccessThread">;

export interface GoalTurnRegistry {
  activeTurnsByThread: Map<string, string>;
  startingThreads: Set<string>;
}

export interface GoalSetInput {
  bridge: GoalBridge;
  store: GoalStore;
  registry: GoalTurnRegistry;
  userId: string;
  threadId: string;
  objective?: string;
  status: string;
  tokenBudget: number | null;
  requestId: string;
  rememberAcceptedTurn: (threadId: string, requestId: string, result: unknown) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function getOwnedThreadGoal(input: { bridge: GoalBridge; store: GoalStore; userId: string; threadId: string }): Promise<{ threadId: string; goal: unknown }> {
  const { bridge, store, userId, threadId } = input;
  if (!store.userCanAccessThread(threadId, userId)) throw new Error("Thread is not visible for this logged-in user.");
  const result = await bridge.request("thread/goal/get", { threadId });
  return { threadId, goal: asRecord(result).goal ?? null };
}

type ThreadState = { state: "idle" | "running" | "scheduled"; turnId?: string; reason?: string };

function statusType(thread: Record<string, unknown>): unknown {
  return typeof thread.status === "string" ? thread.status : asRecord(thread.status).type;
}

function turnState(threadRead: unknown, threadId: string): ThreadState {
  const thread = asRecord(asRecord(threadRead).thread);
  if (thread.id !== threadId) return { state: "scheduled" };
  const status = statusType(thread);
  if (status === "active" || status === "running" || status === "inProgress") {
    return { state: "running", turnId: typeof thread.activeTurnId === "string" ? thread.activeTurnId : undefined };
  }
  if (status === "idle") return { state: "idle" };
  if (status === "notLoaded") return { state: "scheduled", reason: "thread_not_loaded" };
  if (status === "systemError") return { state: "scheduled", reason: "thread_system_error" };
  if (status === undefined || status === null) return { state: "scheduled", reason: "thread_status_missing" };
  return { state: "scheduled", reason: "thread_status_unknown" };
}

/** Persist a Goal, then start one kickoff turn only after authoritative idle-state verification. */
export async function setGoalAndStartIfIdle(input: GoalSetInput): Promise<{ goal: unknown; execution: { state: "started" | "running" | "scheduled" | "inactive"; turnId?: string; reason?: string; error?: string } }> {
  const { bridge, store, registry, userId, threadId, objective, status, tokenBudget, requestId } = input;
  const params: Record<string, unknown> = { threadId, status };
  if (objective !== undefined) params.objective = objective;
  if (tokenBudget !== null) params.tokenBudget = tokenBudget;
  const goalResult = await bridge.request("thread/goal/set", params);
  const goal = asRecord(goalResult).goal ?? goalResult;
  if (status !== "active") return { goal, execution: { state: "inactive" } };
  if (registry.activeTurnsByThread.has(threadId)) {
    const turnId = registry.activeTurnsByThread.get(threadId)!;
    return { goal, execution: { state: "running", ...(!turnId.startsWith("pending:") ? { turnId } : {}) } };
  }
  if (registry.startingThreads.has(threadId)) return { goal, execution: { state: "running" } };

  const owner = store.getThreadOwner(threadId);
  const project = owner ? store.getProject(owner.projectId, userId) : null;
  if (!owner || !project) return { goal, execution: { state: "scheduled", reason: "thread_project_unavailable" } };

  // Reserve the thread across the read/resume/start sequence. Socket turn.start
  // uses this same set, and request deduplication also serializes by this thread.
  registry.startingThreads.add(threadId);
  try {
    let snapshot = await bridge.request("thread/read", { threadId, includeTurns: false }, 30_000);
    let state = turnState(snapshot, threadId);
    if (state.state === "scheduled" && statusType(asRecord(asRecord(snapshot).thread)) === "notLoaded") {
      await bridge.request("thread/resume", { threadId, config: browserMcpForThread(threadId), cwd: owner.rootPath, model: owner.modelOverride ?? project.defaultModel, approvalPolicy: project.defaultApprovalPolicy, sandbox: project.defaultSandbox }, 30_000);
      snapshot = await bridge.request("thread/read", { threadId, includeTurns: false }, 30_000);
      state = turnState(snapshot, threadId);
    }
    const active = registry.activeTurnsByThread.get(threadId);
    if (active) return { goal, execution: { state: "running", ...(!active.startsWith("pending:") ? { turnId: active } : {}) } };
    if (state.state !== "idle") return { goal, execution: { state: state.state, ...(state.turnId ? { turnId: state.turnId } : {}), ...(state.reason ? { reason: state.reason } : {}) } };

    let currentObjective: unknown = objective ?? asRecord(goal).objective;
    if (typeof currentObjective !== "string" || !currentObjective.trim()) {
      try { currentObjective = asRecord(asRecord(await bridge.request("thread/goal/get", { threadId })).goal).objective; }
      catch (error) { return { goal, execution: { state: "scheduled", error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) } }; }
    }
    if (typeof currentObjective !== "string" || !currentObjective.trim()) return { goal, execution: { state: "scheduled", reason: "goal_objective_unavailable" } };
    const turn = await bridge.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `请立即开始执行当前 Goal：${currentObjective.trim()}`, text_elements: [] }],
      cwd: owner.rootPath,
      approvalPolicy: project.defaultApprovalPolicy,
      sandboxPolicy: project.defaultSandbox === "danger-full-access"
        ? { type: "dangerFullAccess" }
        : project.defaultSandbox === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", writableRoots: [project.rootPath], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      model: owner.modelOverride ?? project.defaultModel,
      effort: owner.reasoningEffortOverride ?? project.defaultReasoningEffort
    }, 30_000);
    input.rememberAcceptedTurn(threadId, requestId, turn);
    const turnRecord = asRecord(asRecord(turn).turn);
    return { goal, execution: { state: "started", ...(typeof turnRecord.id === "string" ? { turnId: turnRecord.id } : {}) } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Native Goal continuation may win the race after the authoritative read.
    // Surface every other post-persistence startup failure in the successful
    // Goal acknowledgement so the UI can distinguish saved from executing.
    if (/active turn|turn.*already|goal continuation/i.test(message)) return { goal, execution: { state: "running" } };
    return { goal, execution: { state: "scheduled", error: message.slice(0, 500) } };
  } finally {
    registry.startingThreads.delete(threadId);
  }
}
