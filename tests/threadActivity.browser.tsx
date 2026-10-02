import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { GoalProgress } from "../src/GoalProgress";
import { SubagentActivity, SubagentToolCard } from "../src/SubagentActivity";
import { useThreadGoal } from "../src/threadGoal";
import { collectAgents } from "../src/subagentPresentation";
import { codexSocket } from "../src/codexSocket";
import type { ThreadItem } from "../src/types";
import "../src/threadActivity.css";

type FixtureMessage = { type: string; requestId?: string; ok?: boolean; error?: string; data?: unknown };
type FixtureApi = {
  sent: Array<Record<string, unknown>>;
  ack: (requestId: string, message?: Partial<FixtureMessage>) => void;
  notify: (method: string, params: Record<string, unknown>) => void;
  setThread: (threadId: string | null) => void;
  setRunning: (running: boolean) => void;
  setGoal: (objective: string) => void;
  setItems: (items: ThreadItem[]) => void;
  setOlderItems: (items: ThreadItem[]) => void;
  setAgentTurnRunning: (running: boolean) => void;
};
declare global { interface Window { __threadActivityFixture?: FixtureApi } }

const sent: Array<Record<string, unknown>> = [];
const listeners = new Set<(message: any) => void>();
const statusListeners = new Set<(status: "connecting" | "open" | "closed") => void>();
document.documentElement.dataset.theme = "dark";
// Keep the production hook/components, but replace only the transport with a deterministic in-page mock.
(codexSocket as any).send = (message: Record<string, unknown>) => { sent.push(message); };
(codexSocket as any).subscribe = (listener: (message: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); };
(codexSocket as any).subscribeStatus = (listener: (status: "connecting" | "open" | "closed") => void) => { statusListeners.add(listener); return () => statusListeners.delete(listener); };

const encrypted = "gAAAAABmockedEncryptedDelegationPayload_7F4d0A9xQh2Kx6p8sN3mV1cB";
const initialItems: ThreadItem[] = [
  { id: "spawn-call", type: "toolCall", tool: "exec × 4", input: { task_name: "/root/editor", model: "gpt-6-luna", fork_turns: "all", message: encrypted }, aggregatedOutput: JSON.stringify({ task_name: "/root/editor" }) } as ThreadItem,
  { id: "list-call", type: "toolCall", tool: "工具", output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ agents: [
    { agent_name: "/root/editor", agent_status: { completed: "The editor passed its review. The source selection is safely versioned, the save path rejects stale writes, and the interface remains readable at narrow widths." }, model: "gpt-6-luna" },
    { agent_name: "/root/qa", agent_status: "running", model: "gpt-6-sol" }
  ] }) }] }) } as ThreadItem
];

function Harness() {
  const [threadId, setThreadId] = useState<string | null>("thread-a");
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<ThreadItem[]>(initialItems);
  const [olderItems, setOlderItems] = useState<ThreadItem[]>([]);
  const [agentTurnRunning, setAgentTurnRunning] = useState(true);
  const controller = useThreadGoal(threadId, "mock-user");
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const agents = threadId === "thread-a" ? collectAgents([...olderItems, ...items]) : [];

  useEffect(() => {
    window.__threadActivityFixture = {
      sent,
      ack: (requestId, message = {}) => { for (const listener of listeners) listener({ type: "ack", requestId, ok: true, ...message }); },
      notify: (method, params) => { for (const listener of listeners) listener({ type: "codex.notification", data: { method, params } }); },
      setThread: setThreadId,
      setRunning,
      setGoal: (objective) => controllerRef.current.set(objective),
      setItems,
      setOlderItems,
      setAgentTurnRunning
    };
    return () => { delete window.__threadActivityFixture; };
  }, []);

  return <main>
    <header><strong>Thread activity fixture</strong><span data-testid="thread-id">{threadId ?? "new thread"}</span>
      <button onClick={() => setThreadId("thread-a")}>Thread A</button>
      <button onClick={() => setThreadId("thread-b")}>Thread B</button>
      <button onClick={() => setThreadId(null)}>New empty view</button>
      <button onClick={() => setRunning(value => !value)}>Toggle turn</button>
      <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; }}>Toggle theme</button>
      <button onClick={() => controller.set("Continue revising the article without changing its equations.")}>Set goal fixture</button>
      <button onClick={() => setItems([])}>Clear agents fixture</button>
    </header>
    <div className="activityFixture">
      <GoalProgress key={`${threadId ?? "new"}:mock-user`} controller={controller} running={running} />
      <SubagentActivity key={threadId ?? "new"} agents={agents} />
      <SubagentToolCard item={initialItems[1]} />
    </div>
    <section className="mockHistory" aria-label="Conversation history">Conversation history stays empty</section>
  </main>;
}

const style = document.createElement("style");
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; }
  :root[data-theme="dark"] { color-scheme: dark; }
  :root[data-theme="light"] { color-scheme: light; }
  body { margin: 0; background: var(--bg); color: var(--ui-content); font: 14px/1.5 system-ui, sans-serif; }
  main { width: min(820px, calc(100vw - 40px)); margin: 44px auto; }
  header { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:24px; }
  header strong { margin-right:auto; }
  button { color:var(--ui-content); background:var(--ui-surface-raised); border:1px solid var(--line-strong); border-radius:7px; padding:6px 10px; cursor:pointer; }
  .activityFixture { min-height:150px; padding:12px 16px; border:1px solid var(--line-strong); border-radius:14px; background:var(--ui-surface); color:var(--ui-content-muted); }
  .goalProgressRow { min-height:34px; }
  .threadActivityHeading { text-align:left; }
  .mockHistory { margin-top:22px; color:var(--ui-content-muted); font-size:12px; }
  .goalProgressDetails, .subagentSummary { max-width:700px; }
`;
document.head.append(style);
createRoot(document.getElementById("root")!).render(<Harness />);
