import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import "../src/styles.css";
import { SubagentPanel } from "../src/SubagentPanel";
import { DeferredToolOutput, ReasoningMessage } from "../src/App";
import { ToolReveal } from "../src/ToolReveal";
import { SelectionAskAction } from "../src/SelectionAskAction";
import { SubagentActivity, SubagentToolCard } from "../src/SubagentActivity";
import type { AgentEntry } from "../src/subagentPresentation";
import { readSubagentItemOutput } from "../src/api";
import type { ThreadItem, Turn } from "../src/types";

const parent = "parent";
const project = "project";
document.documentElement.dataset.theme = "dark";
let mainRenders = 0;
Object.defineProperty(window, "subagentFixtureMainRenders", { get: () => mainRenders });
// The fixture controls only the transcript data; disclosure, output loading,
// reasoning and layout are the actual main-chat components/classes.
function FixtureTool({ item, agentId }: { item: ThreadItem; agentId: string }) {
  const [open, setOpen] = useState(false);
  return <article className={`messageItem kind-tool type-toolCall toolBundleEntry${open ? " toolExpanded" : ""}`} aria-expanded={open} onClick={event => { event.stopPropagation(); setOpen(value => !value); }}>
    <div className="messageMeta"><span className="toolBundleEntryLabel">调用工具 · {item.tool}</span><span className="toolBundleEntrySummary"> {String(item.input)}</span></div>
    <ToolReveal open={open}><pre className="toolBundleInput">{String(item.input)}</pre><DeferredToolOutput text={String(item.aggregatedOutput || "")} deferred={item.outputDeferred === true} threadId={agentId} itemId={item.id} projectId={project} loadOutput={async () => (await readSubagentItemOutput(project, parent, agentId, item.id)).data.output} /></ToolReveal>
  </article>;
}
function FixtureBundle({ items, agentId, bundleId, turn, running, render }: { items: ThreadItem[]; agentId: string; bundleId: string; turn: Turn; running: boolean; render: (item: ThreadItem, turn: Turn, agentId: string) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const calls = items.filter(item => item.type === "toolCall");
  const names = [...new Set(calls.map(item => item.tool))];
  return <article className={`messageItem kind-tool type-toolCall toolBundle${open ? " toolExpanded" : ""}${running ? " live toolBundleShimmering" : ""}`} data-message-key={bundleId} aria-expanded={open} onClick={() => setOpen(value => !value)}>
    <div className="messageMeta toolBundleTitle"><span className="toolBundleTitleLabel">调用工具 · {names.length === 1 ? names[0] : "工具"} × {calls.length}</span></div>
    <ToolReveal open={open}><div className="toolBundleEntries" onClick={event => event.stopPropagation()}>
      {items.map(item => <div className="subagentBundleItem" key={item.id} data-message-key={`${turn.id}:${item.id}`}>{render(item, turn, agentId)}</div>)}
    </div></ToolReveal>
  </article>;
}
function Harness() {
  mainRenders++;
  const [present, setPresent] = useState(false);
  const [visible, setVisible] = useState(false);
  const [initialAgent, setInitialAgent] = useState<string | undefined>();
  const [draft, setDraft] = useState("主对话草稿不会随子代理切换而改变");
  const [activity, setActivity] = useState<{ agents: AgentEntry[]; running: boolean; task: string }>({ agents: [], running: false, task: "first" });
  (window as unknown as { setSubagentFixtureActivity: typeof setActivity }).setSubagentFixtureActivity = setActivity;
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const open = (agent?: string) => {
    clearTimeout(closeTimer.current);
    setInitialAgent(agent); setPresent(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
  };
  const close = () => {
    setVisible(false);
    closeTimer.current = setTimeout(() => setPresent(false), 420);
  };
  const render = (item: ThreadItem, _turn: unknown, agentId: string) => item.type === "toolCall"
    ? <FixtureTool item={item} agentId={agentId} />
    : item.type === "reasoning" ? <div className="toolBundleReasoningEntry"><ReasoningMessage text={item.text || ""} /></div>
    : <div className={item.type === "userMessage" ? "subagentRecordUser" : "subagentRecordAnswer"}><div className="messageMarkdown"><ReactMarkdown>{item.text}</ReactMarkdown></div></div>;
  const renderBundle = (items: ThreadItem[], turn: Turn, agentId: string, bundleId: string, running: boolean) => <FixtureBundle key={bundleId} items={items} turn={turn} agentId={agentId} bundleId={bundleId} running={running} render={render} />;
  return <main>
    <div className="fixtureControls"><button onClick={() => open()}>打开子代理</button><button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>切换日夜</button></div>
    <div className={`workspace${visible ? " diffPanelOpen" : ""}`} style={{ gridTemplateColumns: "0px 0px minmax(0, 1fr) auto" }}>
      <section style={{ gridColumn: 3, padding: 20 }}><h2>主会话</h2><SubagentToolCard item={{ id: "spawn", type: "toolCall", tool: "spawn_agent", input: { task_name: "/root/editor", model: "gpt-6-luna" } }} onOpenAgent={open} /><SubagentToolCard item={{ id: "delivery", type: "toolCall", tool: "send_message", input: { target: "/root", message: "gAAAA" + "A".repeat(200) } }} onOpenAgent={open} /><textarea aria-label="主对话草稿" value={draft} onChange={event => setDraft(event.target.value)} /><div className="fixtureActivity"><SubagentActivity agents={activity.agents} parentRunning={activity.running} taskKey={activity.task} directoryPage={{ total: 72, activeCount: activity.agents.filter(agent => agent.state === "running").length, historyCount: 72, unknownCount: 0, matchedCount: 72, hasMore: true, nextCursor: null }} onOpen={open} onOpenHistory={() => open()} /></div></section>
      {present ? <aside className="diffReviewPanel" style={{ width: visible ? 440 : 0 }}><SubagentPanel projectId={project} parentThreadId={parent} initialAgent={initialAgent} visible={visible} parentRunning={false} knownAgents={[{ id: "a", name: "/root/research", state: "running" }, { id: "b", name: "/root/editor", state: "dispatched" }]} onClose={close} renderItem={render} renderBundle={renderBundle} /></aside> : null}
    </div>
    <SelectionAskAction scope="fixture-parent" onAsk={() => {}} />
  </main>;
}
const style = document.createElement("style");
style.textContent = `body { margin: 0; background: var(--bg); color: var(--ui-content); font-family: var(--font-ui); } * { box-sizing: border-box; } main { height: 100dvh; display: flex; flex-direction: column; } .fixtureControls { display: flex; gap: 10px; padding: 12px; } .fixtureControls button { color: var(--ui-content); background: var(--ui-hover); border: 0; padding: 8px; border-radius: 8px; } .workspace { flex: 1; min-height: 0; } textarea { width: 100%; background: var(--ui-surface); color: var(--ui-content); border: 0; padding: 12px; font: inherit; }`;
document.head.append(style);
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
