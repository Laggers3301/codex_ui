import { useEffect, useState } from "react";
import { listSubagentThreads } from "./api";
import type { SubagentDirectoryPage, SubagentThreadSummary } from "./types";
const emptyDirectory = { rows: [] as SubagentThreadSummary[] };

export function sameSubagentDirectory(current: SubagentThreadSummary[], next: SubagentThreadSummary[]): boolean {
  return current.length === next.length && current.every((agent, index) => {
    const other = next[index];
    return agent.id === other.id && agent.name === other.name && agent.parentThreadId === other.parentThreadId
      && agent.model === other.model && agent.reasoningEffort === other.reasoningEffort
      && agent.state === other.state && agent.updatedAt === other.updatedAt
      && agent.createdAt === other.createdAt && agent.lastTaskAt === other.lastTaskAt;
  });
}

/** Discover this thread's children independently of its history window. */
export function useSubagentDirectory(userId: string, projectId: string | undefined, threadId: string | undefined, enabled: boolean, parentRunning: boolean): { rows: SubagentThreadSummary[]; page?: SubagentDirectoryPage } {
  const scope = `${userId}:${projectId ?? ""}:${threadId ?? ""}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; rows: SubagentThreadSummary[]; page?: SubagentDirectoryPage } | null>(null);
  useEffect(() => {
    if (!enabled || !projectId || !threadId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await listSubagentThreads(projectId, threadId, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(current => current?.scope === scope && sameSubagentDirectory(current.rows, response.data) && JSON.stringify(current.page) === JSON.stringify(response.page) ? current : { scope, rows: response.data, page: response.page });
        if (parentRunning || (response.page?.activeCount ?? 0) > 0 || response.data.some(agent => ["running", "waiting", "dispatched"].includes(agent.state))) timer = setTimeout(load, 5000);
      } catch {
        // A historical entry remains readable even during a transient outage.
        if (!controller.signal.aborted && parentRunning) timer = setTimeout(load, 10000);
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [scope, projectId, threadId, enabled, parentRunning]);
  return enabled && snapshot?.scope === scope ? snapshot : emptyDirectory;
}
