import type { SubagentThreadSummary, ThreadItem } from "./types";

export type AgentState = "dispatched" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "unknown";
export type AgentEntry = { id: string; name: string; model?: string; state: AgentState; summary?: string; createdAt?: string | null; lastTaskAt?: string | null; updatedAt?: number | string | null };
export type AgentOperation = { action: string; agents: AgentEntry[]; summary?: string };
const labels: Record<string, string> = {
  spawn_agent: "派发子任务", spawnagent: "派发子任务", createagent: "派发子任务",
  send_message: "发送协作消息", sendmessage: "发送协作消息",
  followup_task: "继续子任务", followuptask: "继续子任务",
  list_agents: "查看子代理状态", listagents: "查看子代理状态",
  wait_agent: "等待子代理", waitagent: "等待子代理", wait: "等待子代理",
  interrupt_agent: "停止子代理", interruptagent: "停止子代理", closeagent: "结束子代理",
};
const MAX_AGENT_PAYLOAD = 128_000;
function object(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return {};
  if (typeof value === "string") {
    if (value.length >= MAX_AGENT_PAYLOAD) return {};
    try { return object(JSON.parse(value), depth + 1); } catch { return {}; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  // MCP tools often wrap their useful JSON result in content[].text. Parse only
  // bounded JSON text; never surface the raw wrapper as a task summary.
  if (Array.isArray(record.content)) {
    for (const part of record.content.slice(0, 32)) {
      const nestedText = part && typeof part === "object" ? (part as Record<string, unknown>).text : undefined;
      if (typeof nestedText !== "string" || nestedText.length >= MAX_AGENT_PAYLOAD) continue;
      const nested = object(nestedText, depth + 1);
      if (Object.keys(nested).length) return { ...record, ...nested };
    }
  }
  return record;
}
function text(value: unknown, max = 220): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\s+/g, " ").trim();
  // Encrypted delegation payloads are runtime data, not a readable task brief.
  return clean && !/^gAAAA[A-Za-z0-9_-]{20}/.test(clean) && !/^[A-Za-z0-9_+/=-]{100,}$/.test(clean)
    ? clean.slice(0, max) : undefined;
}
export function agentState(value: unknown): AgentState {
  const state = object(value);
  const raw = typeof value === "string" ? value : String(state.type ?? Object.keys(state)[0] ?? "");
  const token = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (["completed", "complete", "finished", "done"].includes(token)) return "completed";
  if (["running", "active", "inprogress"].includes(token)) return "running";
  if (["failed", "error", "errored"].includes(token)) return "failed";
  if (["interrupted", "stopped", "cancelled", "canceled", "shutdown"].includes(token)) return "interrupted";
  if (["idle", "waiting", "pending", "paused"].includes(token)) return "waiting";
  return "unknown";
}
function entry(value: unknown, fallbackId?: string, defaultState: AgentState = "unknown"): AgentEntry | null {
  const row = object(value);
  const id = text(row.agent_id ?? row.agentId ?? row.threadId ?? row.thread_id ?? row.agent_name ?? row.task_name ?? row.taskName ?? row.id ?? row.name) ?? fallbackId;
  if (!id) return null;
  const status = row.agent_status ?? row.status ?? row.state;
  return { id, name: text(row.agent_name ?? row.task_name ?? row.taskName ?? row.name) ?? id,
    model: text(row.model, 80), state: status != null ? agentState(status) : defaultState,
    summary: text(object(status).completed ?? row.last_task_message ?? row.summary ?? row.message, 3000) };
}
export function parseAgentOperation(item: ThreadItem): AgentOperation | null {
  if (item.collaboration && typeof item.collaboration === "object") item = { ...item, ...object(item.collaboration) } as ThreadItem;
  const tool = String(item.tool ?? item.name ?? "").toLowerCase().split(/[./]/).pop() ?? "";
  const native = String(item.type).toLowerCase() === "collabagenttoolcall";
  const actionKey = native ? String(item.tool ?? item.action ?? "").toLowerCase().split(/[./]/).pop() ?? "" : tool;
  const input = object(item.input ?? item.arguments ?? item.command);
  const output = object(item.aggregatedOutput ?? item.output ?? item.result);
  // A code-mode cell wait is not a collaboration wait.
  if (!native && actionKey === "wait" && input.cell_id !== undefined) return null;
  const legacyTaskName = text(input.task_name ?? input.taskName ?? output.task_name ?? output.taskName);
  const legacyMessage = input.message ?? input.task_message;
  const legacyEncryptedSpawn = Boolean(legacyTaskName && typeof input.model === "string" &&
    (input.fork_turns !== undefined || input.forkTurns !== undefined) && typeof legacyMessage === "string" &&
    /^gAAAA[A-Za-z0-9_-]{20}/.test(legacyMessage));
  const outputAgents = Array.isArray(output.agents) ? output.agents : Array.isArray(output.data) ? output.data : [];
  const legacyAgentList = outputAgents.some(value => {
    const row = object(value);
    return typeof row.agent_name === "string" || row.agent_status !== undefined;
  });
  const effectiveActionKey = labels[actionKey] ? actionKey : legacyEncryptedSpawn ? "spawn_agent" : legacyAgentList ? "list_agents" : actionKey;
  const action = labels[effectiveActionKey];
  if (!action && !native) return null;
  const agents: AgentEntry[] = [];
  const rawAgents = output.agents ?? output.data ?? input.agents;
  if (Array.isArray(rawAgents)) for (const row of rawAgents.slice(0, 48)) { const agent = entry(row); if (agent) agents.push(agent); }
  for (const [id, value] of Object.entries(object(item.agentsStates ?? output.agentsStates ?? output.agent_states)).slice(0, 48)) {
    const state = object(value); const agent = entry({ ...state, status: state.status ?? state.state ?? value }, id); if (agent) agents.push(agent);
  }
  if (!agents.length) {
    const receivers = Array.isArray(input.ids) ? input.ids : Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    for (const id of receivers.slice(0, 48)) {
      const name = text(id);
      if (name) agents.push({ id: name, name, state: "unknown" });
    }
  }
  if (!agents.length) {
    const id = text(output.task_name ?? output.agent_id ?? output.agentId ?? input.task_name ?? input.target ?? input.agent_id
      ?? (Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds[0] : undefined));
    const spawned = effectiveActionKey.includes("spawn") || effectiveActionKey === "createagent";
    const agent = entry({ ...input, ...output, task_name: input.task_name ?? output.task_name,
      id, status: output.status ?? (native ? item.status : undefined) }, id, spawned ? "dispatched" : "unknown");
    // A completed spawn tool confirms dispatch, not the completion of the agent.
    if (agent) { if (spawned && agent.state === "completed") agent.state = "dispatched"; agents.push(agent); }
  }
  return { action: action ?? "子代理协作", agents, summary: text(input.message ?? item.prompt)
    ?? (effectiveActionKey.startsWith("wait") && !agents.length ? "等待任一子代理的状态更新" : undefined) };
}
export function collectAgents(items: ThreadItem[]): AgentEntry[] {
  const agents = new Map<string, AgentEntry>();
  for (const item of items) {
    const operation = parseAgentOperation(item);
    if (!operation) continue;
    for (const next of operation.agents) {
      const old = agents.get(next.id) ?? [...agents.values()].find(row => row.name.replace(/^\/root\//, "") === next.name.replace(/^\/root\//, ""));
      agents.set(old?.id ?? next.id, { ...old, ...next, id: old?.id ?? next.id,
        model: next.model ?? old?.model, summary: next.summary ?? old?.summary,
        state: next.state === "unknown" ? old?.state ?? "unknown" : next.state });
    }
  }
  return [...agents.values()].filter(agent => agent.name !== "/root");
}

export function isActiveAgent<T extends { state: AgentState }>(agent: T): boolean {
  return agent.state === "running" || agent.state === "dispatched" || agent.state === "waiting";
}
/** Directory membership is independent of message pagination. */
export function reconcileSubagents(loaded: AgentEntry[], directory: SubagentThreadSummary[]): AgentEntry[] {
  const canonical = (name: string) => name.replace(/^\/root\//, "");
  const reconciled = loaded.map(agent => {
    const native = directory.find(row => row.id === agent.id || canonical(row.name) === canonical(agent.name));
    if (!native) return agent;
    const state = agentState(native.state);
    return { ...agent, id: native.id, createdAt: native.createdAt, lastTaskAt: native.lastTaskAt, updatedAt: native.updatedAt, model: native.model ?? agent.model,
      state: state === "unknown" && !isActiveAgent(agent) ? agent.state : state };
  });
  for (const native of directory) {
    if (native.name === "/root" || reconciled.some(agent => agent.id === native.id || canonical(agent.name) === canonical(native.name))) continue;
    reconciled.push({ id: native.id, name: native.name, model: native.model ?? undefined, state: agentState(native.state), createdAt: native.createdAt, lastTaskAt: native.lastTaskAt, updatedAt: native.updatedAt });
  }
  return reconciled;
}
export const agentStateLabel: Record<AgentState, string> = { dispatched: "已派发", running: "执行中", waiting: "等待中", completed: "已完成", failed: "失败", interrupted: "已停止", unknown: "状态待确认" };
