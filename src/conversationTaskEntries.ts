import type { ConversationTask } from "../shared/conversationTasks";
import { agentState, isActiveAgent, type AgentEntry, type AgentState } from "./subagentPresentation";

export interface ConversationTaskEntry {
  id: string;
  kind: "agent" | "shell" | "unknown";
  name: string;
  state: AgentState;
  model?: string;
  summary?: string;
  task?: ConversationTask;
}

/** The native task and the directory transcript describe one agent, not two jobs. */
export function conversationTaskEntries(agents: AgentEntry[], tasks: ConversationTask[]): ConversationTaskEntry[] {
  const rows = new Map<string, ConversationTaskEntry>();
  for (const agent of agents) rows.set(`agent:${agent.id}`, { ...agent, kind: "agent" });
  for (const task of tasks) {
    const kind = task.kind === "unknown" && rows.has(`agent:${task.id}`) ? "agent" : task.kind;
    const key = `${kind === "agent" ? "agent" : "task"}:${task.id}`, known = rows.get(key);
    rows.set(key, { id: task.id, kind, name: task.description || known?.name || task.id,
      state: agentState(task.status), model: known?.model, summary: task.summary || known?.summary, task });
  }
  return [...rows.values()].sort((a, b) => Number(isActiveAgent(b)) - Number(isActiveAgent(a))
    || (b.task?.updatedAt ?? 0) - (a.task?.updatedAt ?? 0) || a.id.localeCompare(b.id));
}
