import { isActiveAgent, type AgentEntry } from "./subagentPresentation";
import type { SubagentThreadSummary } from "./types";

export function activityWindow(agents: AgentEntry[], observed: Map<string, AgentEntry>, parentRunning: boolean) {
  for (const agent of agents) {
    if (isActiveAgent(agent) || observed.has(agent.id)) observed.set(agent.id, agent);
  }
  const active = agents.filter(isActiveAgent);
  const recent = parentRunning ? [...observed.values()].filter(agent => !isActiveAgent(agent)) : [];
  return { active, recent, rows: [...active, ...recent.slice(-3)] };
}

export function mergeDirectoryRows(current: SubagentThreadSummary[], next: SubagentThreadSummary[]): SubagentThreadSummary[] {
  const rows = new Map(current.map(row => [row.id, row]));
  for (const row of next) rows.set(row.id, row);
  return [...rows.values()];
}

export function subagentDate(agent: SubagentThreadSummary): Date | null {
  const value = agent.lastTaskAt ?? agent.createdAt ?? agent.updatedAt;
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function groupSubagentDirectory(rows: SubagentThreadSummary[]): Array<{ key: string; date: Date | null; agents: SubagentThreadSummary[] }> {
  const groups = new Map<string, { key: string; date: Date | null; agents: SubagentThreadSummary[] }>();
  for (const agent of rows) {
    const date = subagentDate(agent);
    const key = date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : "undated";
    if (!groups.has(key)) groups.set(key, { key, date, agents: [] });
    groups.get(key)!.agents.push(agent);
  }
  return [...groups.values()];
}
