import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Users, Terminal, X, RefreshCw, ArrowUpRight } from "lucide-react";
import { agentStateLabel, isActiveAgent, type AgentEntry } from "./subagentPresentation";
import { conversationTaskEntries, type ConversationTaskEntry } from "./conversationTaskEntries";
import { useConversationTasks } from "./conversationTasks";
import type { SubagentDirectoryPage } from "./types";
import { AccountUpdateIndicator } from "./AccountUpdateIndicator";
import "./taskNotificationSettings.css";
import "./conversationTasks.css";

const keyOf = (task: ConversationTaskEntry) => `${task.kind === "agent" ? "agent" : "task"}:${task.id}`;
function TasksDialog({ entries, native, error, loading, agentTotal, onRefresh, onClose, onOpenAgent, onOpenHistory }: {
  entries: ConversationTaskEntry[]; native: boolean; error: string; loading: boolean; agentTotal: number;
  onRefresh: () => void; onClose: () => void; onOpenAgent: (id: string) => void; onOpenHistory: () => void;
}) {
  const [tab, setTab] = useState<"all" | "agents" | "background">("all"), [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [closing, setClosing] = useState(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dismiss = (after?: () => void) => {
    if (timer.current) return;
    setClosing(true);
    timer.current = setTimeout(() => { onClose(); if (after) requestAnimationFrame(after); }, 220);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const title = useId(), panel = useRef<HTMLElement>(null), close = useRef(() => dismiss()); close.current = () => dismiss();
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>('[aria-label="关闭会话任务"]')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === "Tab") {
        const controls = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input,a[href],[tabindex="0"]')].filter(node => node.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const rows = entries.filter(row => (tab === "agents" ? row.kind === "agent" : tab === "background" ? row.kind !== "agent" : true)
    && `${row.name} ${row.id} ${row.summary ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const current = entries.find(row => keyOf(row) === selected);
  const navigate = (callback: () => void) => dismiss(callback);
  return createPortal(<div className={`taskNotificationScrim conversationTasksScrim${closing ? " uiClosing" : ""}`} aria-hidden={closing} inert={closing} onKeyDown={event => event.stopPropagation()} onMouseDown={event => { if (event.target === event.currentTarget) dismiss(); }}>
    <section ref={panel} className="taskNotificationDialog conversationTasksDialog" role="dialog" aria-modal="true" aria-labelledby={title}>
      <header><h2 id={title}>{native ? "子代理与后台任务" : "子代理"}</h2><div className="conversationTasksActions">
        {native ? <button type="button" className="taskNotificationIcon" aria-label="刷新会话任务" onClick={onRefresh} disabled={loading}><RefreshCw size={16}/></button> : null}
        <button type="button" className="taskNotificationIcon" aria-label="关闭会话任务" onClick={() => dismiss()}><X size={16}/></button>
      </div></header>
      <div className="conversationTasksControls"><div className="conversationTasksTabs" role="tablist" aria-label="任务类型">
        {([["all", "全部"], ["agents", "子代理"], ...(native ? [["background", "后台任务"]] : [])] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id as typeof tab); setSelected(null); }}>{label}</button>)}
      </div><input aria-label="搜索会话任务" value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} placeholder="搜索任务"/></div>
      {error ? <div className="conversationTasksError" role="alert">状态更新失败：{error}<button type="button" onClick={onRefresh}>重试</button></div> : null}
      <div className={`conversationTasksBody${current ? " hasSelection" : ""}`}>
        <div className="conversationTasksList" aria-label="会话任务列表">
          {rows.map(row => <button type="button" key={keyOf(row)} className={`conversationTaskRow${selected === keyOf(row) ? " selected" : ""}`} aria-pressed={selected === keyOf(row)} onClick={() => setSelected(keyOf(row))}>
            {row.kind === "agent" ? <Users size={16}/> : <Terminal size={16}/>}
            <span className="conversationTaskName"><strong>{row.name.replace(/^\/root\//, "")}</strong><span>{row.kind === "agent" ? "子代理" : "后台任务"}{row.task?.subagentType ? ` · ${row.task.subagentType}` : ""}{row.model ? ` · ${row.model}` : ""}</span></span>
            <span className={`conversationTaskState state-${row.state}`}>{agentStateLabel[row.state]}</span>
          </button>)}
          {!rows.length ? <p className="conversationTasksEmpty" role="status">{loading ? "正在读取任务…" : query ? "没有匹配的任务。" : tab === "background" ? "当前会话暂无后台任务。" : tab === "agents" || !native ? "当前会话暂无子代理。" : "当前会话暂无子代理或后台任务。"}</p> : null}
          {agentTotal > entries.filter(row => row.kind === "agent").length ? <button type="button" className="conversationTasksMore" onClick={() => navigate(onOpenHistory)}>查看全部 {agentTotal} 条子代理记录<ArrowUpRight size={14}/></button> : null}
        </div>
        {current ? <div className="conversationTaskDetails" aria-label="任务详情">
          <button className="conversationTaskBack" type="button" onClick={() => setSelected(null)}>返回任务列表</button>
          <h3>{current.name}</h3><p className={`conversationTaskState state-${current.state}`}>{agentStateLabel[current.state]}{current.task?.background ? isActiveAgent(current) ? " · 后台运行" : " · 后台任务" : ""}</p>
          <dl><dt>任务 ID</dt><dd>{current.id}</dd>{current.task?.parentTaskId ? <><dt>父任务</dt><dd>{current.task.parentTaskId}</dd></> : null}
            {current.task?.lastToolName ? <><dt>最近工具</dt><dd>{current.task.lastToolName}</dd></> : null}
            {current.task?.usage ? <><dt>累计活动</dt><dd>{current.task.usage.toolUses} 次工具调用 · {Math.round(current.task.usage.durationMs / 1000)} 秒 · {current.task.usage.totalTokens.toLocaleString()} tokens</dd></> : null}
            {current.task?.updatedAt ? <><dt>最近更新</dt><dd>{new Date(current.task.updatedAt).toLocaleString("zh-CN", { hour12: false })}</dd></> : null}</dl>
          <h4>{isActiveAgent(current) ? "最新进度" : "结果摘要"}</h4><pre className="conversationTaskSummary">{current.summary || (isActiveAgent(current) ? "任务运行中，等待下一条进度更新。" : "尚未收到任务摘要。")}</pre>
          {current.kind === "agent" ? <button type="button" className="taskNotificationTest" onClick={() => navigate(() => onOpenAgent(current.id))}>打开完整执行记录<ArrowUpRight size={14}/></button> : null}
        </div> : <div className="conversationTaskDetails conversationTaskDetailPlaceholder">选择任务，查看进度与结果。</div>}
      </div>
    </section>
  </div>, document.body);
}

export function ConversationTasks({ userId, projectId, threadId, native, agents, directoryPage, parentRunning, onOpenAgent, onOpenHistory, triggerLabel = "任务", plainTrigger = false }: {
  userId: string; projectId: string; threadId: string; native: boolean; agents: AgentEntry[]; directoryPage?: SubagentDirectoryPage;
  parentRunning: boolean; onOpenAgent: (id: string) => void; onOpenHistory: () => void;
  triggerLabel?: string;
  plainTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false), [opening, setOpening] = useState(0);
  const state = useConversationTasks(userId, projectId, threadId, native, parentRunning);
  const entries = useMemo(() => conversationTaskEntries(agents, state.tasks), [agents, state.tasks]);
  const agentCount = Math.max(entries.filter(row => row.kind === "agent").length, directoryPage?.total ?? 0);
  const running = Math.max(entries.filter(row => row.kind === "agent" && isActiveAgent(row)).length, directoryPage?.activeCount ?? 0)
    + entries.filter(row => row.kind !== "agent" && isActiveAgent(row)).length;
  const label = native ? "子代理与后台任务" : "子代理";
  return <><button type="button" className={plainTrigger ? "conversationTasksTrigger" : "iconTextButton v2FastModeButton conversationTasksTrigger"} aria-label={label} title={`${label} · ${running ? `${running} 项进行中` : `${agentCount + entries.filter(row => row.kind !== "agent").length} 项记录`}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpening(value => value + 1); setOpen(true); state.refresh(); }}>
    <span>{triggerLabel}</span>{running ? <span className="conversationTasksCount" aria-label={`${running} 项进行中`} aria-live="polite">{running}</span> : null}<AccountUpdateIndicator userId={userId} menuOpen={open} target="tasks"/>
  </button>{open ? <TasksDialog key={opening} entries={entries} native={native} agentTotal={agentCount} error={state.error} loading={state.loading} onRefresh={state.refresh} onClose={() => setOpen(false)} onOpenAgent={onOpenAgent} onOpenHistory={onOpenHistory}/> : null}</>;
}
