import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Close, Refresh } from "@icon-park/svg";
import { listSubagentThreads, readSubagentThread } from "./api";
import { agentState, agentStateLabel, isActiveAgent, type AgentEntry } from "./subagentPresentation";
import { groupSubagentRecordItems, mergeSubagentHistory, type SubagentRecordGroup } from "./subagentHistory";
import { SubagentAvatar } from "./SubagentAvatar";
import { coalesceToolOutputs } from "./conversationTimeline";
import { sameSubagentDirectory } from "./subagentDirectory";
import { VirtualConversation, type VirtualConversationHandle } from "./VirtualConversation";
import type { SubagentThreadSummary, ThreadReadResponse, Turn, ThreadItem } from "./types";
import "./subagentPanel.css";
import { SubagentDirectoryList } from "./SubagentDirectoryList";
import type { SubagentDirectoryPage } from "./types";

function Glyph({ name }: { name: "back" | "close" | "refresh" }) {
  const svg = ({ back: ArrowLeft, close: Close, refresh: Refresh }[name])({ theme: "outline", size: 16, strokeWidth: 3, fill: "currentColor" }).replace(/^<\?xml[^>]*>/, "");
  return <span className="threadActivityIcon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
const shortName = (name: string) => name.replace(/^\/root\//, "");
const canonical = (name: string) => shortName(name).replace(/^\//, "");

function RecordLoading({ active, label }: { active: boolean; label: string }) {
  const [present, setPresent] = useState(active);
  useEffect(() => {
    if (active) { setPresent(true); return; }
    const timer = setTimeout(() => setPresent(false), 240);
    return () => clearTimeout(timer);
  }, [active]);
  if (!active && !present) return null;
  return <div className={`subagentLoadingLayer${active ? "" : " closing"}`} role="status" aria-label={label} aria-hidden={!active}>
    <div className="threadOpeningIndicator"><span className="threadOpeningPulse" aria-hidden="true"><i /><i /><i /></span></div>
  </div>;
}

export function SubagentPanel({ projectId, parentThreadId, initialAgent, initialView, visible, parentRunning, knownAgents, onClose, renderItem, renderBundle }: {
  projectId: string;
  parentThreadId: string;
  initialAgent?: string;
  initialView?: "active" | "history";
  visible: boolean;
  parentRunning: boolean;
  knownAgents: AgentEntry[];
  onClose: () => void;
  renderItem: (item: ThreadItem, turn: Turn, agentId: string) => ReactNode;
  renderBundle: (items: ThreadItem[], turn: Turn, agentId: string, bundleId: string, lastActivity: boolean) => ReactNode;
}) {
  const [agents, setAgents] = useState<SubagentThreadSummary[]>([]);
  const [directoryCounts, setDirectoryCounts] = useState<SubagentDirectoryPage>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ThreadReadResponse | null>(null);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [recordLoading, setRecordLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refreshCycle = useRef<{ revision: number; scope: string; pending: Set<"directory" | "record"> } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const record = useRef<HTMLDivElement>(null);
  const recordVirtual = useRef<VirtualConversationHandle>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const olderController = useRef<AbortController | null>(null);
  const olderInFlight = useRef(false);
  const historyFailed = useRef(false);
  const historyGate = useRef({ until: 0, settling: false, rearmTop: null as number | null });
  const historyRearmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollGesture = useRef({ direction: "" as "" | "up" | "down", at: 0, top: 0, touchY: 0 });
  const follow = useRef(true);
  const appliedInitialAgent = useRef<string | undefined>(undefined);
  const loadedScope = useRef("");
  const groupedHistory = useRef<{ scope: string; rows: SubagentRecordGroup[] }>({ scope: "", rows: [] });

  const refresh = () => {
    if (refreshCycle.current) return;
    const next = revision + 1;
    refreshCycle.current = { revision: next, scope: `${projectId}:${parentThreadId}:${selectedId ?? ""}`, pending: new Set(selectedId ? ["directory", "record"] : ["directory"]) };
    setRefreshing(true);
    setRevision(next);
  };
  const finishRefresh = (part: "directory" | "record", requestRevision: number) => {
    const cycle = refreshCycle.current;
    if (!cycle || cycle.revision !== requestRevision) return;
    cycle.pending.delete(part);
    if (!cycle.pending.size) { refreshCycle.current = null; setRefreshing(false); }
  };
  useEffect(() => {
    if (visible && refreshCycle.current?.scope === `${projectId}:${parentThreadId}:${selectedId ?? ""}`) return;
    refreshCycle.current = null;
    setRefreshing(false);
  }, [projectId, parentThreadId, selectedId, visible]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let childRunning = false;
    const load = async () => {
      try {
        const response = await listSubagentThreads(projectId, parentThreadId, controller.signal);
        if (!controller.signal.aborted) {
          childRunning = (response.page?.activeCount ?? 0) > 0 || response.data.some(agent => isActiveAgent({ state: agentState(agent.state) }));
          setDirectoryCounts(response.page);
          setAgents(current => {
            // A selected historical child can lie beyond the first page. Keep
            // its identity when the lightweight global directory refreshes.
            const selected = current.find(agent => agent.id === selectedRef.current);
            const next = selected && !response.data.some(agent => agent.id === selected.id) ? [...response.data, selected] : response.data;
            return sameSubagentDirectory(current, next) ? current : next;
          });
          setError("");
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!controller.signal.aborted) {
          setListLoading(false);
          finishRefresh("directory", revision);
          if ((parentRunning || childRunning) && visible) timer = setTimeout(load, 5000);
        }
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, parentThreadId, parentRunning, revision, visible]);

  useEffect(() => {
    if (!visible || !initialAgent || initialAgent === appliedInitialAgent.current || listLoading) return;
    const target = agents.find(agent => agent.id === initialAgent || canonical(agent.name) === canonical(initialAgent));
    if (target) { appliedInitialAgent.current = initialAgent; setSelectedId(target.id); return; }
    const controller = new AbortController();
    void listSubagentThreads(projectId, parentThreadId, controller.signal, { q: initialAgent, view: "all", limit: 100 }).then(response => {
      if (controller.signal.aborted) return;
      const found = response.data.find(agent => agent.id === initialAgent || canonical(agent.name) === canonical(initialAgent));
      if (found) { appliedInitialAgent.current = initialAgent; setAgents(current => [...current.filter(agent => agent.id !== found.id), found]); setSelectedId(found.id); }
      else setError("未找到这条子代理记录，请在历史目录中检索。");
    }).catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => controller.abort();
  }, [initialAgent, agents, visible, listLoading, projectId, parentThreadId]);

  const effectiveAgents = useMemo(() => agents.map(agent => {
    const latest = knownAgents.find(known => known.id === agent.id || canonical(known.name) === canonical(agent.name));
    const persistedState = agentState(agent.state);
    // A stale dispatch in an older parent page must never replace a child's
    // explicit completion. Parent events fill only an unavailable status.
    return { ...agent, state: persistedState === "unknown" ? latest?.state ?? persistedState : persistedState };
  }), [agents, knownAgents]);
  const selected = effectiveAgents.find(agent => agent.id === selectedId);
  const selectedRunning = Boolean(selected && isActiveAgent({ ...selected, state: agentState(selected.state) }));
  const selectedState = agentState(selected?.state);

  useEffect(() => {
    if (!selectedId) { setView(null); setRecordLoading(false); return; }
    if (!visible) return;
    const scope = `${projectId}:${parentThreadId}:${selectedId}`;
    if (loadedScope.current !== scope || viewRef.current?.thread.id !== selectedId) {
      loadedScope.current = scope;
      olderController.current?.abort();
      clearTimeout(historyRearmTimer.current);
      olderInFlight.current = false;
      historyFailed.current = false;
      setHistoryError("");
      historyGate.current = { until: 0, settling: false, rearmTop: null };
      scrollGesture.current = { direction: "", at: 0, top: 0, touchY: 0 };
      setOlderLoading(false);
      follow.current = true;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const initial = viewRef.current?.thread.id !== selectedId;
    if (initial) setRecordLoading(true);
    setError("");
    const load = async (initial: boolean) => {
      try {
        const response = await readSubagentThread(projectId, parentThreadId, selectedId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        // Manual refresh must not move a reader back to the newest record.
        // Use the same sole anchor owner as history prepending, before merging.
        if (!initial && !follow.current && !olderInFlight.current && refreshCycle.current?.revision === revision && refreshCycle.current.pending.has("record")) {
          recordVirtual.current?.captureHistoryAnchor();
          setHistoryRevision(value => value + 1);
        }
        setView(current => !initial && current?.thread.id === selectedId ? {
          thread: mergeSubagentHistory(current.thread, response.thread),
          history: current.history ? { ...current.history, totalItems: response.history?.totalItems ?? current.history.totalItems } : response.history
        } : response);
        setError("");
        // Poll only the selected child while its persisted turn is running.
        const status = agentState(response.thread.turns.at(-1)?.status);
        if (visible && (status === "running" || status === "waiting" || (status === "unknown" && selectedRunning))) timer = setTimeout(() => void load(false), 2500);
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!controller.signal.aborted) { setRecordLoading(false); finishRefresh("record", revision); }
      }
    };
    void load(initial);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, parentThreadId, selectedId, revision, selectedRunning, visible]);

  useEffect(() => () => { olderController.current?.abort(); clearTimeout(historyRearmTimer.current); }, []);
  useEffect(() => {
    if (visible) return;
    olderController.current?.abort();
    olderInFlight.current = false;
    historyGate.current.settling = false;
    clearTimeout(historyRearmTimer.current);
    setOlderLoading(false);
  }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (selectedRef.current) setSelectedId(null); else onClose();
    };
    const element = panel.current;
    element?.addEventListener("keydown", escape as EventListener);
    return () => element?.removeEventListener("keydown", escape as EventListener);
  }, [visible, onClose]);
  useEffect(() => {
    if (visible) panel.current?.querySelector<HTMLButtonElement>('button[aria-label="收起子代理面板"]')?.focus({ preventScroll: true });
  }, [visible]);

  const loadOlder = async () => {
    const current = viewRef.current;
    if (!visible || !current?.history?.hasOlder || !selectedId || current.thread.id !== selectedId || olderInFlight.current) return;
    const scope = loadedScope.current;
    olderInFlight.current = true;
    historyGate.current.settling = true;
    follow.current = false;
    historyFailed.current = false;
    setHistoryError("");
    const controller = new AbortController();
    olderController.current = controller;
    setOlderLoading(true);
    try {
      const response = await readSubagentThread(projectId, parentThreadId, selectedId, {
        before: current.history.nextBefore, beforeCursor: current.history.nextCursor ?? undefined, limit: 160, signal: controller.signal
      });
      if (controller.signal.aborted || selectedRef.current !== selectedId || loadedScope.current !== scope) return;
      // Capture the visible text at commit time, not at request time: the reader
      // can keep moving during the fetch. The main chat's single scroll controller
      // owns both restoration and bottom-following; there is no second scrollTop writer.
      recordVirtual.current?.captureHistoryAnchor();
      setView(latest => latest?.thread.id === selectedId ? { thread: mergeSubagentHistory(response.thread, latest.thread), history: response.history } : latest);
      setHistoryRevision(value => value + 1);
      setError("");
    } catch (caught) {
      if (!controller.signal.aborted && loadedScope.current === scope) {
        historyFailed.current = true;
        setHistoryError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (!controller.signal.aborted && loadedScope.current === scope) {
        olderInFlight.current = false;
        historyGate.current.until = Date.now() + 950;
        setOlderLoading(false);
        historyRearmTimer.current = setTimeout(() => {
          if (loadedScope.current !== scope) return;
          historyGate.current.rearmTop = record.current?.scrollTop ?? 0;
          historyGate.current.settling = false;
          // Discard the gesture that fetched this page (including its inertia).
          // Later virtual measurements are not a new request to load history.
          scrollGesture.current.direction = "";
          scrollGesture.current.at = 0;
        }, 750);
      }
    }
  };

  const maybeLoadOlder = () => {
    const element = record.current, gate = historyGate.current;
    if (!element || recordLoading || historyFailed.current || olderInFlight.current || gate.settling
      || Date.now() < gate.until || element.scrollTop > Math.max(520, element.clientHeight * .75)) return;
    // Each page requires another deliberate upward gesture after measurement.
    // Prepending, polling, and returning to the bottom must not chain requests.
    if (gate.rearmTop !== null) {
      if (gate.rearmTop <= 1 && element.scrollTop > 140) { gate.rearmTop = element.scrollTop; return; }
      if (element.scrollTop > gate.rearmTop - 72) return;
      gate.rearmTop = null;
    }
    void loadOlder();
  };
  const noteScrollGesture = (direction: "up" | "down") => {
    scrollGesture.current.direction = direction;
    scrollGesture.current.at = Date.now();
    if (direction === "up") { follow.current = false; maybeLoadOlder(); }
  };
  const transcript = useMemo(() => {
    if (!view) return [];
    const scope = `${projectId}:${parentThreadId}:${view.thread.id}`;
    const previous = groupedHistory.current.scope === scope ? groupedHistory.current.rows : [];
    return view.thread.turns.flatMap(turn => {
      const nodes = new Map(coalesceToolOutputs(turn.items).map(item => [item, renderItem(item, turn, view.thread.id)]));
      const groups = groupSubagentRecordItems(turn.id, [...nodes].filter(([, node]) => node !== null && node !== undefined).map(([item]) => item), previous);
      return groups.map((row, index) => {
        const type = row.items[0].type.toLowerCase();
        const activity = row.bundle || ["reasoning", "toolcall", "filechange"].includes(type);
        const runningActivity = activity && index === groups.length - 1 && turn.id === view.thread.turns.at(-1)?.id
          && agentState(turn.status) === "running" && !["completed", "failed", "interrupted"].includes(selectedState);
        return { ...row, activity, runningActivity, node: row.bundle ? renderBundle(row.items, turn, view.thread.id, `subagent:${view.thread.id}:${row.key}`, runningActivity) : nodes.get(row.items[0]) };
      });
    });
  }, [view, renderItem, renderBundle, projectId, parentThreadId, selectedState]);
  useLayoutEffect(() => {
    if (view) groupedHistory.current = { scope: `${projectId}:${parentThreadId}:${view.thread.id}`, rows: transcript };
  }, [transcript, view, projectId, parentThreadId]);

  const directoryView = initialView ?? (effectiveAgents.some(agent => isActiveAgent({ state: agentState(agent.state) })) ? "active" : "history");
  return <section ref={panel} className={`rightPaneSubagents${visible ? " open" : ""}`} aria-label="子代理完整记录" aria-hidden={!visible} inert={!visible}>
    <header className="diffReviewPanelHeader subagentPanelHeader">
      {selectedId ? <button type="button" onClick={() => setSelectedId(null)} aria-label="返回子代理列表"><Glyph name="back" /></button> : null}
      <div className="subagentPanelTitle">{selected ? <SubagentAvatar name={selected.name} /> : null}<h2 title={selected?.name}>{selected ? shortName(selected.name) : "子代理"}</h2></div>
      {selected ? <span className="subagentRecordModel" title={[selected.model, selected.reasoningEffort, agentStateLabel[selectedState]].filter(Boolean).join(" ")}>{selected.model ? <span className="subagentRecordModelName">{selected.model}{selected.reasoningEffort ? ` ${selected.reasoningEffort}` : ""}</span> : null}<span className={`subagentState${selectedState === "running" || selectedState === "dispatched" ? " subagentRunningShimmer" : ""}`}>{agentStateLabel[selectedState]}</span></span> : null}
      <button type="button" aria-label="刷新子代理记录" aria-busy={refreshing} disabled={refreshing} onClick={refresh}><Glyph name="refresh" /></button>
      <button type="button" aria-label="收起子代理面板" onClick={onClose}><Glyph name="close" /></button>
    </header>
    {historyError || error ? <div className="subagentPanelError" role="alert">{historyError || error}<button type="button" onClick={() => { if (historyFailed.current) { void loadOlder(); } else refresh(); }}>重试</button></div> : null}
    {!selectedId ? listLoading ? <div className="subagentDirectory"><RecordLoading active label="正在读取子代理" /></div> : <SubagentDirectoryList projectId={projectId} parentThreadId={parentThreadId} visible={visible} revision={revision} initialView={directoryView} counts={directoryCounts} liveRows={agents} onSelect={agent => { setAgents(current => [...current.filter(row => row.id !== agent.id), agent]); setSelectedId(agent.id); }} renderLoading={(active, label) => <RecordLoading active={active} label={label} />} /> : <>
      <nav className="subagentSiblingTabs" aria-label="切换子代理">{effectiveAgents.map(agent => <button type="button" key={agent.id} aria-pressed={agent.id === selectedId} onClick={() => setSelectedId(agent.id)} title={agent.name}><SubagentAvatar name={agent.name} /><span>{shortName(agent.name)}</span></button>)}</nav>
      <div className="subagentRecordStage">
        <RecordLoading active={recordLoading || refreshing} label="正在读取子代理记录" />
        {olderLoading ? <div className="subagentHistoryLoading" role="status" aria-label="正在读取更早的子代理记录"><span /></div> : null}
        <VirtualConversation ref={recordVirtual} containerRef={record} threadKey={`${projectId}:${parentThreadId}:${selectedId}`} virtualize historyRevision={historyRevision}
          estimateRowSize={index => transcript[index]?.activity ? 32 : 200}
          shouldFollowEnd={() => follow.current && !recordLoading && viewRef.current?.thread.id === selectedRef.current}
          className={`subagentRecord${recordLoading || view?.thread.id !== selectedId ? " switching" : ""}`} aria-hidden={recordLoading || view?.thread.id !== selectedId} inert={recordLoading || view?.thread.id !== selectedId} tabIndex={0}
          onWheel={event => { if (event.deltaY) noteScrollGesture(event.deltaY < 0 ? "up" : "down"); }}
          onTouchStart={event => { scrollGesture.current.touchY = event.touches[0]?.clientY ?? 0; }}
          onTouchMove={event => {
            const y = event.touches[0]?.clientY;
            if (y === undefined) return;
            if (Math.abs(y - scrollGesture.current.touchY) > 3) noteScrollGesture(y > scrollGesture.current.touchY ? "up" : "down");
            scrollGesture.current.touchY = y;
          }}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return;
            if (["ArrowUp", "PageUp", "Home"].includes(event.key)) noteScrollGesture("up");
            else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) noteScrollGesture("down");
          }}
          onScroll={event => {
            const element = event.currentTarget, gesture = scrollGesture.current;
            if (Date.now() - gesture.at < 1500) {
              if (gesture.direction === "up" && element.scrollTop < gesture.top) { follow.current = false; maybeLoadOlder(); }
              else if (gesture.direction === "down" && element.scrollTop > gesture.top && element.scrollHeight - element.scrollTop - element.clientHeight < 48) follow.current = true;
            }
            gesture.top = element.scrollTop;
          }}>
          {transcript.map((row, index) => {
            const next = transcript[index + 1];
            const gap = !next ? 0 : next.turnId !== row.turnId ? 17 : row.activity && next.activity ? 4 : 13;
            return <div className={`subagentRecordRow${row.activity ? " kind-tool" : ""}${row.runningActivity ? " subagentActivityRunning" : ""}`} key={row.key} data-message-key={row.key} data-subagent-item={row.key} style={{ paddingBottom: gap }} onClickCapture={row.bundle ? () => { follow.current = false; } : undefined}>{row.node}</div>;
          })}
          {view?.thread.id === selectedId && !transcript.length && !recordLoading ? <p key="empty" className="subagentPanelEmpty">尚未产生执行记录。</p> : null}
        </VirtualConversation>
      </div>
    </>}
  </section>;
}
