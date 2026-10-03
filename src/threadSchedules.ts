import { useCallback, useEffect, useRef, useState } from "react";
import { getApiUserId } from "./api";

export type ScheduleKind = "once" | "interval" | "daily" | "weekdays" | "weekly";
export interface ThreadSchedule {
  id: string;
  title: string;
  prompt: string;
  schedule: { kind: ScheduleKind; at?: string; intervalMinutes?: number; time?: string; weekdays?: number[]; timezone: string };
  enabled: boolean;
  status?: "active" | "paused" | "completed" | "failed" | string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRunStatus?: "completed" | "failed" | "running" | string;
  lastRunError?: string | null;
  lastError?: string | null;
  recentRuns?: Array<{ status: string; startedAt?: string; error?: string }>;
  history?: Array<{ status: string; scheduledAt?: string; startedAt?: string; error?: string; warning?: string }>;
}
export type ScheduleDraft = Omit<ThreadSchedule, "id" | "status" | "nextRunAt" | "lastRunAt" | "lastRunStatus" | "lastRunError" | "recentRuns">;

async function request<T>(projectId: string, threadId: string, tail = "", init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/schedules${tail}`, {
    ...init, credentials: "same-origin", headers: { "Content-Type": "application/json", "x-codex-web-user-id": getApiUserId(), ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ? `${body.error ?? "Request failed"}: ${body.message}` : body.error ?? `Request failed: ${response.status}`);
  return body as T;
}
export async function listThreadSchedules(projectId: string, threadId: string, signal?: AbortSignal): Promise<ThreadSchedule[]> {
  const result = await request<{ data?: ThreadSchedule[] }>(projectId, threadId, "", { signal });
  return result.data ?? (result as unknown as ThreadSchedule[]);
}
export async function createThreadSchedule(projectId: string, threadId: string, draft: ScheduleDraft): Promise<ThreadSchedule> {
  const result = await request<{ data?: ThreadSchedule }>(projectId, threadId, "", { method: "POST", body: JSON.stringify(draft) });
  return result.data ?? result as ThreadSchedule;
}
export async function updateThreadSchedule(projectId: string, threadId: string, id: string, draft: Partial<ScheduleDraft>): Promise<ThreadSchedule> {
  const result = await request<{ data?: ThreadSchedule }>(projectId, threadId, `/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(draft) });
  return result.data ?? result as ThreadSchedule;
}
export async function deleteThreadSchedule(projectId: string, threadId: string, id: string): Promise<void> {
  await request(projectId, threadId, `/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function useThreadSchedules(projectId: string, threadId: string) {
  const scope = `${getApiUserId()}\u0000${projectId}\u0000${threadId}`;
  const [result, setResult] = useState<{scope: string; schedules: ThreadSchedule[]; error: string}>({scope, schedules: [], error: ""});
  const [loadedScope, setLoadedScope] = useState("");
  const requestId = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const loading = loadedScope !== scope;
  const schedules = result.scope === scope ? result.schedules : [];
  const error = result.scope === scope ? result.error : "";
  const refresh = useCallback(async () => {
    if (scopeRef.current !== scope) return;
    if (!projectId || !threadId) { setResult({scope, schedules: [], error: ""}); setLoadedScope(scope); return; }
    const id = ++requestId.current;
    const controller = new AbortController();
    try {
      const data = await listThreadSchedules(projectId, threadId, controller.signal);
      if (id === requestId.current && scopeRef.current === scope) { setResult({scope, schedules: data, error: ""}); setLoadedScope(scope); }
    } catch (e) {
      if (id === requestId.current && scopeRef.current === scope && !(e instanceof DOMException && e.name === "AbortError")) {
        setResult(previous => ({scope, schedules: previous.scope === scope ? previous.schedules : [], error: e instanceof Error ? e.message : String(e)}));
        setLoadedScope(scope);
      }
    }
  }, [projectId, threadId, scope]);
  const setError = useCallback((message: string) => {
    if (scopeRef.current === scope) setResult(previous => ({scope, schedules: previous.scope === scope ? previous.schedules : [], error: message}));
  }, [scope]);
  useEffect(() => {
    const initial = new AbortController();
    let disposed = false;
    const load = async () => {
      if (!projectId || !threadId) { setResult({scope, schedules: [], error: ""}); setLoadedScope(scope); return; }
      const id = ++requestId.current;
      try {
        const data = await listThreadSchedules(projectId, threadId, initial.signal);
        if (!disposed && id === requestId.current && scopeRef.current === scope) { setResult({scope, schedules: data, error: ""}); setLoadedScope(scope); }
      } catch (e) {
        if (!disposed && id === requestId.current && scopeRef.current === scope && !(e instanceof DOMException && e.name === "AbortError")) {
          setResult(previous => ({scope, schedules: previous.scope === scope ? previous.schedules : [], error: e instanceof Error ? e.message : String(e)})); setLoadedScope(scope);
        }
      }
    };
    setResult({scope, schedules: [], error: ""}); setLoadedScope("");
    void load();
    const timer = window.setInterval(() => { if (!document.hidden && !disposed) void refresh(); }, 15000);
    return () => { disposed = true; initial.abort(); ++requestId.current; window.clearInterval(timer); };
  }, [scope, projectId, threadId, refresh]);
  return { projectId, threadId, schedules, loading, error, refresh, setError };
}
