import { useRef, useState } from "react";
import { PeoplesTwo, Down, Check } from "@icon-park/svg";
import { ToolReveal } from "./ToolReveal";
import { SubagentAvatar } from "./SubagentAvatar";
import { agentStateLabel, isActiveAgent, parseAgentOperation, type AgentEntry } from "./subagentPresentation";
import type { ThreadItem } from "./types";
import type { SubagentDirectoryPage } from "./types";
import { activityWindow } from "./subagentOrganization";
import "./threadActivity.css";

export function ActivityIcon({ name }: { name: "agents" | "down" }) {
  const svg = (name === "agents" ? PeoplesTwo : Down)({ theme: "outline", size: 16, fill: "currentColor", strokeWidth: 3 }).replace(/^<\?xml[^>]*>/, "");
  return <span className="threadActivityIcon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
function AgentRow({ agent, onOpen }: { agent: AgentEntry; onOpen?: (name?: string) => void }) {
  const [open, setOpen] = useState(false);
  return <div><button type="button" className="subagentRow" disabled={!onOpen && !agent.summary} aria-expanded={onOpen ? undefined : open} onClick={event => { event.stopPropagation(); if (onOpen) onOpen(agent.name); else setOpen(value => !value); }}><SubagentAvatar name={agent.name} /><span className="subagentName">{agent.name.replace(/^\/root\//, "")}</span>{agent.model ? <span className="subagentModel">{agent.model}</span> : null}<span className={`subagentState state-${agent.state}${agent.state === "running" || agent.state === "dispatched" ? " subagentRunningShimmer" : ""}`}>{agent.state === "completed" ? <span className="subagentCompletionIcon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: Check({ theme: "outline", size: 12, fill: "currentColor", strokeWidth: 3 }).replace(/^<\?xml[^>]*>/, "") }} /> : null}{agentStateLabel[agent.state]}</span></button>{onOpen ? null : <ToolReveal open={open}>{agent.summary ? <p className="subagentSummary">{agent.summary}</p> : null}</ToolReveal>}</div>;
}
export function SubagentToolCard({ item, onOpenAgent, knownAgents = [] }: { item: ThreadItem; onOpenAgent?: (name?: string) => void; knownAgents?: AgentEntry[] }) {
  const operation = parseAgentOperation(item);
  if (!operation) return null;
  const agents = operation.agents.length ? operation.agents.map(agent => {
    const known = knownAgents.find(row => row.id === agent.id || row.name === agent.name);
    return known ? { ...agent, name: known.name, model: known.model, state: item.completed === false ? known.state : agent.state } : agent;
  }) : operation.action === "等待子代理" && item.completed === false ? knownAgents.filter(isActiveAgent) : [];
  if (operation.action === "发送协作消息") return <div className="subagentToolCard subagentMessageDelivery" aria-label={operation.action}>
    <div className="subagentOperation" title={operation.summary}>
      <ActivityIcon name="agents" /><span className="subagentDeliveryAction">发送协作消息</span><span aria-hidden="true">→</span>
      <span className="subagentRecipients">{agents.length ? agents.map(agent => {
        const root = agent.name === "/root";
        const label = root ? "主代理" : agent.name.replace(/^\/root\//, "");
        const content = <><SubagentAvatar name={agent.name} /><span>{label}</span></>;
        return !root && onOpenAgent ? <button type="button" className="subagentRecipient" key={agent.id} title={agent.name} onClick={event => { event.stopPropagation(); onOpenAgent(agent.name); }}>{content}</button>
          : <span className="subagentRecipient" key={agent.id} title={agent.name}>{content}</span>;
      }) : <span className="subagentRecipient">收件人未记录</span>}</span>
    </div>
  </div>;
  return <div className="subagentToolCard" aria-label={operation.action}>
    <div className="subagentOperation"><ActivityIcon name="agents" />{operation.action}</div>
    {agents.map(agent => <AgentRow key={agent.id} agent={agent} onOpen={onOpenAgent} />)}
    {operation.summary ? <p>{operation.summary}</p> : null}
    {!agents.length && !operation.summary ? <span className="subagentState">等待协作状态更新</span> : null}
  </div>;
}
export function SubagentActivity({ agents, onOpen, onOpenHistory, parentRunning = false, taskKey = "", directoryPage }: { agents: AgentEntry[]; onOpen?: (name?: string) => void; onOpenHistory?: () => void; parentRunning?: boolean; taskKey?: string; directoryPage?: SubagentDirectoryPage }) {
  const [open, setOpen] = useState(false);
  const batch = useRef({ taskKey, observed: new Map<string, AgentEntry>() });
  if (batch.current.taskKey !== taskKey) batch.current = { taskKey, observed: new Map() };
  const activity = activityWindow(agents, batch.current.observed, parentRunning);
  const active = Math.max(activity.active.length, directoryPage?.activeCount ?? 0);
  const total = Math.max(agents.length, directoryPage?.total ?? 0);
  const unknown = directoryPage?.unknownCount ?? agents.filter(agent => agent.state === "unknown").length;
  const present = total > 0;
  const activityPresent = active > 0 || activity.recent.length > 0;
  const uncertainRecent = activity.recent.filter(agent => agent.state === "unknown").length;
  const recentLabel = uncertainRecent ? `${uncertainRecent} 项状态待确认` : `${activity.recent.length} 个本轮已结束`;
  const summary = active ? `子代理 · ${active} 个进行中${activity.recent.length ? ` · ${recentLabel}` : ""}`
    : uncertainRecent ? `本轮子代理 · ${recentLabel}` : `本轮 ${activity.recent.length} 个子代理${activity.recent.every(agent => agent.state === "completed") ? "已完成" : "已结束"}`;
  const retained = useRef({ rows: activity.rows, summary });
  if (activityPresent) retained.current = { rows: activity.rows, summary };
  return <ToolReveal open={present}><section className="threadActivityStrip subagentActivity" aria-label="子代理活动">
    <ToolReveal open={activityPresent} className="subagentCurrentActivity">
      <button className="threadActivityHeading" type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <ActivityIcon name="agents" /><span>{retained.current.summary}</span><span className={open ? "activityChevron open" : "activityChevron"}><ActivityIcon name="down" /></span>
      </button>
      <ToolReveal open={open && activityPresent}><div className="subagentRows">{retained.current.rows.map(agent => <AgentRow key={agent.id} agent={agent} onOpen={onOpen} />)}
        {onOpen && (active > activity.active.length || activity.recent.length > 3) ? <button className="subagentMoreActivity" type="button" onClick={() => onOpen()}>查看全部本轮记录</button> : null}
      </div></ToolReveal>
    </ToolReveal>
    <button className="threadActivityHeading subagentHistoryButton" type="button" disabled={!onOpenHistory && !onOpen} onClick={() => onOpenHistory ? onOpenHistory() : onOpen?.()}>
      <ActivityIcon name="agents" /><span>子代理记录 · {total}</span>{unknown ? <span className="subagentHistoryUncertain">{unknown} 项状态待确认</span> : null}
    </button>
  </section></ToolReveal>;
}
