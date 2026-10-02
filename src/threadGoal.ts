import { useCallback, useEffect, useRef, useState } from "react";
import { codexSocket } from "./codexSocket";

export type ThreadGoal = { threadId: string; objective: string; status: string; tokenBudget?: number | null; tokensUsed?: number; timeUsedSeconds?: number };
export function goalFrom(value: unknown, threadId: string): ThreadGoal | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const goal = (data.goal ?? data) as Record<string, unknown>;
  if (!goal || goal.threadId !== threadId || typeof goal.objective !== "string" || typeof goal.status !== "string") return null;
  return goal as ThreadGoal;
}
export function useThreadGoal(threadId: string | null, userId: string) {
  const key = `${userId}:${threadId ?? ""}`;
  const [state, setState] = useState<{ key: string; goal: ThreadGoal | null; pending: boolean; error: string }>({ key, goal: null, pending: false, error: "" });
  const scopeRef = useRef({ threadId, userId });
  const requests = useRef(new Map<string, { threadId: string; userId: string; type: string; timer: ReturnType<typeof setTimeout> }>());
  scopeRef.current = { threadId, userId };
  const update = useCallback((patch: Partial<Omit<typeof state, "key">>) => {
    const scope = scopeRef.current;
    const scopeKey = `${scope.userId}:${scope.threadId ?? ""}`;
    setState(previous => ({ ...(previous.key === scopeKey ? previous : { key: scopeKey, goal: null, pending: false, error: "" }), ...patch }));
  }, []);
  const request = useCallback((type: string, extra: Record<string, unknown> = {}) => {
    const scope = scopeRef.current;
    if (!scope.threadId) return;
    const token = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const requestId = `goal-${type.split(".")[1]}-${token}`;
    const timer = setTimeout(() => {
      requests.current.delete(requestId);
      if (scopeRef.current.threadId === scope.threadId && scopeRef.current.userId === scope.userId && type !== "goal.get") {
        update({ pending: false, error: "目标请求尚未确认，请重试查询状态。" });
      }
    }, 65_000);
    requests.current.set(requestId, { ...scope, threadId: scope.threadId, type, timer });
    if (type !== "goal.get") update({ pending: true, error: "" });
    try { codexSocket.send({ type, requestId, userId: scope.userId, threadId: scope.threadId, ...extra }); }
    catch (caught) { clearTimeout(timer); requests.current.delete(requestId); update({ pending: false, error: caught instanceof Error ? caught.message : String(caught) }); }
  }, [update]);
  useEffect(() => {
    update({ goal: null, error: "", pending: false });
    const dispose = codexSocket.subscribe(message => {
      if (message.type === "ack" && message.requestId) {
        const record = requests.current.get(message.requestId);
        if (!record) return;
        clearTimeout(record.timer); requests.current.delete(message.requestId);
        if (record.threadId !== scopeRef.current.threadId || record.userId !== scopeRef.current.userId) return;
        if (record.type !== "goal.get") update({ pending: false });
        if (!message.ok) { update({ error: message.error ?? "目标操作失败" }); return; }
        const data = message.data as { execution?: { state?: string; error?: string; reason?: string } } | undefined;
        const startupError = data?.execution?.error ? `目标已保存，启动未确认：${data.execution.error}` : data?.execution?.reason && data.execution.state === "scheduled" ? "目标已保存，当前会话尚未开始执行，可点击继续重试。" : "";
        update({ goal: record.type === "goal.clear" ? null : goalFrom(message.data, record.threadId), error: startupError });
      }
      if (message.type === "codex.notification") {
        const notification = message.data as { method?: string; params?: Record<string, unknown> };
        const params = notification?.params;
        if (params?.threadId !== scopeRef.current.threadId) return;
        if (notification.method === "thread/goal/updated") update({ goal: goalFrom(params, String(params.threadId)) });
        if (notification.method === "thread/goal/cleared") update({ goal: null, error: "" });
        if (notification.method === "turn/completed") request("goal.get");
      }
    });
    const stopStatus = codexSocket.subscribeStatus(status => { if (status === "open") request("goal.get"); });
    if (threadId) request("goal.get");
    return () => { dispose(); stopStatus(); for (const record of requests.current.values()) clearTimeout(record.timer); requests.current.clear(); };
  }, [threadId, userId, request, update]);
  // Hide stale state in the very render that changes threads, before effects run.
  const scoped = state.key === key && threadId ? state : { goal: null, pending: false, error: "" };
  return { ...scoped, set: (objective: string) => request("goal.set", { objective, status: "active" }),
    pause: () => request("goal.set", { status: "paused" }), resume: () => request("goal.set", { status: "active" }),
    clear: () => request("goal.clear"), refresh: () => request("goal.get") };
}
