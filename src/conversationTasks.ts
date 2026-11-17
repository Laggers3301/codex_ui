import { useCallback, useEffect, useRef, useState } from "react";
import { readConversationTasks } from "./api";
import type { ConversationTask } from "../shared/conversationTasks";

export const conversationTasksEvent = "codex:conversation-tasks";
export function useConversationTasks(userId: string, projectId: string, threadId: string, native: boolean, parentRunning: boolean) {
  const scope = `${userId}:${projectId}:${threadId}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; tasks: ConversationTask[]; error: string; loading: boolean }>();
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (!native) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, pending = false, again = false, running = parentRunning;
    setSnapshot(current => current?.scope === scope ? current : { scope, tasks: [], error: "", loading: true });
    const load = async () => {
      if (controller.signal.aborted) return;
      if (pending) { again = true; return; }
      clearTimeout(timer); pending = true;
      try {
        const response = await readConversationTasks(projectId, threadId, controller.signal);
        if (controller.signal.aborted) return;
        running = parentRunning || response.data.some(task => task.status === "running");
        setSnapshot(current => current?.scope === scope && !current.error && !current.loading && JSON.stringify(current.tasks) === JSON.stringify(response.data)
          ? current : { scope, tasks: response.data, error: "", loading: false });
      } catch (error) {
        if (!controller.signal.aborted) setSnapshot(current => ({ scope, tasks: current?.scope === scope ? current.tasks : [],
          error: error instanceof Error ? error.message : "任务状态暂未更新。", loading: false }));
      } finally {
        pending = false;
        if (!controller.signal.aborted) {
          if (again) { again = false; void load(); }
          else if (running) timer = setTimeout(load, 5000);
        }
      }
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string; threadId: string }>).detail;
      if (detail?.userId === userId && detail.threadId === threadId) void load();
    };
    refreshRef.current = () => void load();
    window.addEventListener(conversationTasksEvent, changed);
    void load();
    return () => { controller.abort(); clearTimeout(timer); refreshRef.current = () => {}; window.removeEventListener(conversationTasksEvent, changed); };
  }, [scope, userId, projectId, threadId, native, parentRunning]);
  return { tasks: native && snapshot?.scope === scope ? snapshot.tasks : [],
    error: native && snapshot?.scope === scope ? snapshot.error : "", loading: native && (!snapshot || snapshot.scope !== scope || snapshot.loading), refresh };
}
