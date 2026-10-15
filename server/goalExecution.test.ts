import { describe, expect, it, vi } from "vitest";
import { getOwnedThreadGoal, setGoalAndStartIfIdle, type GoalBridge, type GoalStore } from "./goalExecution.js";

function setup(options: { active?: boolean; userId?: string } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  const requestMock = vi.fn(async (method: string, params: any): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { id: "thread-a", status: { type: "idle" } } };
      if (method === "turn/start") return { turn: { id: "turn-a" } };
      return { ok: true };
    });
  const bridge: GoalBridge = { request: requestMock };
  const owner = { projectId: "project-a", rootPath: "/project", modelOverride: null, reasoningEffortOverride: null };
  const project = { rootPath: "/project", defaultModel: "model", defaultReasoningEffort: "medium", defaultApprovalPolicy: "never", defaultSandbox: "workspace-write" };
  const store = {
    getThreadOwner: vi.fn(() => owner),
    getProject: vi.fn((projectId: string, userId: string) => projectId === "project-a" && userId === (options.userId ?? "user-a") ? project : null),
    userCanAccessThread: vi.fn((threadId: string, userId: string) => threadId === "thread-a" && userId === (options.userId ?? "user-a"))
  } as unknown as GoalStore;
  const registry = { activeTurnsByThread: new Map<string, string>(options.active ? [["thread-a", "active-turn"]] : []), startingThreads: new Set<string>() };
  const rememberAcceptedTurn = vi.fn((threadId: string, requestId: string, result: any) => registry.activeTurnsByThread.set(threadId, result.turn.id));
  return { calls, bridge, requestMock, store, registry, rememberAcceptedTurn };
}

describe("native Goal kickoff", () => {
  it("reads Goal state only for a thread owned by the authenticated user", async () => {
    const state = setup();
    await expect(getOwnedThreadGoal({ ...state, userId: "user-a", threadId: "thread-a" })).resolves.toEqual({ threadId: "thread-a", goal: null });
    await expect(getOwnedThreadGoal({ ...state, userId: "another-user", threadId: "thread-a" })).rejects.toThrow(/not visible/);
    expect(state.calls).toEqual([{ method: "thread/goal/get", params: { threadId: "thread-a" } }]);
  });

  it("waits for set acknowledgement, reads the same thread, and starts once only when idle", async () => {
    const state = setup();
    const goalAck = { goal: { objective: "ship it", status: "active" } };
    state.requestMock.mockImplementation(async (method: string, params: any): Promise<unknown> => {
      state.calls.push({ method, params });
      if (method === "thread/goal/set") return goalAck;
      if (method === "thread/read") return { thread: { id: "thread-a", status: { type: "idle" } } };
      if (method === "turn/start") return { turn: { id: "turn-a" } };
      return {};
    });
    const result = await setGoalAndStartIfIdle({ ...state, userId: "user-a", threadId: "thread-a", objective: "ship it", status: "active", tokenBudget: null, requestId: "request-a" });
    expect(result).toEqual({ goal: goalAck.goal, execution: { state: "started", turnId: "turn-a" } });
    expect(state.calls.map(({ method }) => method)).toEqual(["thread/goal/set", "thread/read", "turn/start"]);
    expect(state.calls.every(({ params }) => params.threadId === "thread-a")).toBe(true);
    expect(state.rememberAcceptedTurn).toHaveBeenCalledWith("thread-a", "request-a", { turn: { id: "turn-a" } });
    expect(state.registry.activeTurnsByThread.get("thread-a")).toBe("turn-a");
    expect(state.registry.startingThreads.size).toBe(0);
  });

  it("does not duplicate a locally tracked active turn", async () => {
    const state = setup({ active: true });
    await setGoalAndStartIfIdle({ ...state, userId: "user-a", threadId: "thread-a", objective: "continue", status: "active", tokenBudget: null, requestId: "request-b" });
    expect(state.calls.map(({ method }) => method)).toEqual(["thread/goal/set"]);
  });

  it("uses the native thread snapshot to avoid a turn missed by local notifications", async () => {
    const state = setup();
    state.requestMock.mockImplementation(async (method: string, params: any): Promise<unknown> => {
      state.calls.push({ method, params });
      if (method === "thread/read") return { thread: { id: "thread-a", status: { type: "active", activeFlags: [] } } };
      return {};
    });
    await setGoalAndStartIfIdle({ ...state, userId: "user-a", threadId: "thread-a", objective: "continue", status: "active", tokenBudget: null, requestId: "request-c" });
    expect(state.calls.map(({ method }) => method)).toEqual(["thread/goal/set", "thread/read"]);
    expect(state.rememberAcceptedTurn).not.toHaveBeenCalled();
  });

  it("resumes not-loaded threads and rechecks runtime state before starting", async () => {
    const state = setup();
    let reads = 0;
    state.requestMock.mockImplementation(async (method: string, params: any): Promise<unknown> => {
      state.calls.push({ method, params });
      if (method === "thread/read") return { thread: { id: "thread-a", status: { type: reads++ === 0 ? "notLoaded" : "idle" } } };
      if (method === "turn/start") return { turn: { id: "turn-a" } };
      return {};
    });
    const result = await setGoalAndStartIfIdle({ ...state, userId: "user-a", threadId: "thread-a", objective: "continue", status: "active", tokenBudget: null, requestId: "request-loaded" });
    expect(state.calls.map(({ method }) => method)).toEqual(["thread/goal/set", "thread/read", "thread/resume", "thread/read", "turn/start"]);
    expect(result).toMatchObject({ execution: { state: "started", turnId: "turn-a" } });
  });

  it("allows objective-free status updates without replacing goal or token budget", async () => {
    const state = setup();
    await setGoalAndStartIfIdle({ ...state, userId: "user-a", threadId: "thread-a", status: "paused", tokenBudget: null, requestId: "request-pause" });
    expect(state.calls).toEqual([{ method: "thread/goal/set", params: { threadId: "thread-a", status: "paused" } }]);
  });

  it("resumes an existing Goal without sending an empty replacement objective", async () => {
    const state = setup();
    state.requestMock.mockImplementation(async (method: string, params: any): Promise<unknown> => {
      state.calls.push({ method, params });
      if (method === "thread/goal/set") return { goal: { threadId: "thread-a", status: "active" } };
      if (method === "thread/goal/get") return { goal: { objective: "existing objective", tokenBudget: 42 } };
      if (method === "thread/read") return { thread: { id: "thread-a", status: { type: "idle" } } };
      if (method === "turn/start") return { turn: { id: "turn-a" } };
      return {};
    });
    await setGoalAndStartIfIdle({ ...state, userId: "user-a", threadId: "thread-a", status: "active", tokenBudget: null, requestId: "request-resume" });
    expect(state.calls[0]).toEqual({ method: "thread/goal/set", params: { threadId: "thread-a", status: "active" } });
    expect(state.calls[1]).toEqual({ method: "thread/read", params: { threadId: "thread-a", includeTurns: false } });
    expect(state.calls[2]).toEqual({ method: "thread/goal/get", params: { threadId: "thread-a" } });
    const started = state.calls.find(({ method }) => method === "turn/start");
    expect(started?.params.input[0].text).toContain("existing objective");
  });

  it("fails closed for a foreign owner or a missing native runtime status without loading full history", async () => {
    const foreign = setup({ userId: "another-user" });
    await setGoalAndStartIfIdle({ ...foreign, userId: "user-a", threadId: "thread-a", objective: "continue", status: "active", tokenBudget: null, requestId: "request-d" });
    expect(foreign.calls.map(({ method }) => method)).toEqual(["thread/goal/set"]);

    const ambiguous = setup();
    ambiguous.requestMock.mockImplementation(async (method: string, params: any): Promise<unknown> => {
      ambiguous.calls.push({ method, params });
      return method === "thread/read" ? { thread: { id: "thread-a" } } : {};
    });
    await setGoalAndStartIfIdle({ ...ambiguous, userId: "user-a", threadId: "thread-a", objective: "continue", status: "active", tokenBudget: null, requestId: "request-e" });
    expect(ambiguous.calls.map(({ method }) => method)).toEqual(["thread/goal/set", "thread/read"]);
    expect(ambiguous.calls.some(({ params }) => params.includeTurns === true)).toBe(false);
  });

  it("still acknowledges a persisted Goal when kickoff cannot read thread state", async () => {
    const state = setup();
    state.requestMock.mockImplementation(async (method: string, params: any): Promise<unknown> => {
      state.calls.push({ method, params });
      if (method === "thread/goal/set") return { goal: { objective: "saved", status: "active" } };
      if (method === "thread/read") throw new Error("temporary read failure");
      return {};
    });
    const result = await setGoalAndStartIfIdle({ ...state, userId: "user-a", threadId: "thread-a", objective: "saved", status: "active", tokenBudget: null, requestId: "request-scheduled" });
    expect(result).toEqual({ goal: { objective: "saved", status: "active" }, execution: { state: "scheduled", error: "temporary read failure" } });
    expect(state.calls.map(({ method }) => method)).toEqual(["thread/goal/set", "thread/read"]);
  });

  it("fails closed for system-error runtime status instead of treating an empty turns list as idle", async () => {
    const state = setup();
    state.requestMock.mockImplementation(async (method: string, params: any): Promise<unknown> => {
      state.calls.push({ method, params });
      if (method === "thread/goal/set") return { goal: { objective: "saved", status: "active" } };
      if (method === "thread/read") return { thread: { id: "thread-a", status: { type: "systemError" }, turns: [] } };
      return {};
    });
    const result = await setGoalAndStartIfIdle({ ...state, userId: "user-a", threadId: "thread-a", objective: "saved", status: "active", tokenBudget: null, requestId: "request-error-status" });
    expect(result).toMatchObject({ execution: { state: "scheduled" } });
    expect(state.calls.map(({ method }) => method)).toEqual(["thread/goal/set", "thread/read"]);
  });

  it("reports a real kickoff failure after Goal persistence instead of claiming it started", async () => {
    const state = setup();
    state.requestMock.mockImplementation(async (method: string, params: any): Promise<unknown> => {
      state.calls.push({ method, params });
      if (method === "thread/goal/set") return { goal: { objective: "saved", status: "active" } };
      if (method === "thread/read") return { thread: { id: "thread-a", status: { type: "idle" } } };
      if (method === "turn/start") throw new Error("native start failed");
      return {};
    });
    const result = await setGoalAndStartIfIdle({ ...state, userId: "user-a", threadId: "thread-a", objective: "saved", status: "active", tokenBudget: null, requestId: "request-start-error" });
    expect(result).toEqual({ goal: { objective: "saved", status: "active" }, execution: { state: "scheduled", error: "native start failed" } });
    expect(state.calls.map(({ method }) => method)).toEqual(["thread/goal/set", "thread/read", "turn/start"]);
  });
});
