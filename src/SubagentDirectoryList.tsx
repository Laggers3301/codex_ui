import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listSubagentThreads } from "./api";
import { SubagentAvatar } from "./SubagentAvatar";
import { agentState, agentStateLabel } from "./subagentPresentation";
import { groupSubagentDirectory, mergeDirectoryRows, subagentDate } from "./subagentOrganization";
import { VirtualConversation, type VirtualConversationHandle } from "./VirtualConversation";
import { ToolReveal } from "./ToolReveal";
import type { SubagentDirectoryPage, SubagentThreadSummary } from "./types";

const dateLabel = (date: Date | null) => date ? date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) : "早期记录";

export function SubagentDirectoryList({ projectId, parentThreadId, visible, revision, initialView, counts, liveRows, onSelect, renderLoading }: {
  projectId: string; parentThreadId: string; visible: boolean; revision: number;
  initialView: "active" | "history"; counts?: SubagentDirectoryPage; liveRows: SubagentThreadSummary[];
  onSelect: (agent: SubagentThreadSummary) => void;
  renderLoading: (active: boolean, label: string) => ReactNode;
}) {
  const [view, setView] = useState(initialView);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<SubagentThreadSummary[]>([]);
  const [page, setPage] = useState<SubagentDirectoryPage | undefined>();
  const [loading, setLoading] = useState(true);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const virtualList = useRef<VirtualConversationHandle>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const appendController = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const downGesture = useRef(0);
  const touchY = useRef(0);
  const scope = `${projectId}:${parentThreadId}:${view}:${search}:${revision}:${retry}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const globalCounts = page ?? counts;

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!visible) return;
    appendController.current?.abort(); pending.current = false;
    const controller = new AbortController();
    setLoading(true); setAppending(false); setError("");
    void listSubagentThreads(projectId, parentThreadId, controller.signal, { view, q: search, limit: 40 }).then(response => {
      if (controller.signal.aborted || currentScope.current !== scope) return;
      setRows(response.data); setPage(response.page);
    }).catch(caught => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => { if (!controller.signal.aborted && currentScope.current === scope) setLoading(false); });
    return () => { controller.abort(); appendController.current?.abort(); };
  }, [scope, projectId, parentThreadId, view, search, visible]);

  useEffect(() => {
    if (loading || !visible) return;
    // Lightweight native directory polling updates states without throwing
    // away appended pages or closing the transcript that the reader selected.
    const current = rowsRef.current;
    const next = mergeDirectoryRows(current, liveRows).filter(agent => {
        const active = ["running", "waiting", "dispatched"].includes(agent.state);
        return (view === "active" ? active : !active) && (!search || `${agent.id} ${agent.name} ${agent.model ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    });
    if (!(current.length === next.length && current.every((row, index) => row === next[index]))) {
      virtualList.current?.captureHistoryAnchor();
      setHistoryRevision(value => value + 1);
      setRows(next);
    }
    if (counts) setPage(current => current ? { ...current, total: counts.total, activeCount: counts.activeCount, historyCount: counts.historyCount, unknownCount: counts.unknownCount } : current);
  }, [liveRows, counts, view, search, loading, visible]);

  const loadMore = async () => {
    if (!visible || !page?.hasMore || !page.nextCursor || pending.current || loading || error) return;
    pending.current = true; setAppending(true);
    const controller = new AbortController(); appendController.current = controller;
    const requestedScope = scope;
    try {
      const response = await listSubagentThreads(projectId, parentThreadId, controller.signal, { view, q: search, cursor: page.nextCursor, limit: 40 });
      if (controller.signal.aborted || currentScope.current !== requestedScope) return;
      // Append only. Stable keys and the shared virtual list preserve the
      // visible position; no second scrollTop writer or bottom-follow exists.
      setRows(current => mergeDirectoryRows(current, response.data)); setPage(response.page);
    } catch (caught) {
      if (!controller.signal.aborted && currentScope.current === requestedScope) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!controller.signal.aborted && currentScope.current === requestedScope) { pending.current = false; setAppending(false); downGesture.current = 0; }
    }
  };
  const groups = useMemo(() => groupSubagentDirectory(rows), [rows]);
  const entries = useMemo(() => groups.flatMap(group => [
    <h3 className="subagentDirectoryDate" key={`date:${group.key}`}>{dateLabel(group.date)}</h3>,
    ...group.agents.map(agent => {
      const state = agentState(agent.state), date = subagentDate(agent);
      return <button className="subagentDirectoryRow" type="button" key={agent.id} onClick={() => onSelect(agent)} data-agent-id={agent.id} title={agent.name}>
        <SubagentAvatar name={agent.name} /><span className="subagentDirectoryIdentity"><span className="subagentDirectoryName">{agent.name.replace(/^\/root\//, "")}</span>
          <span className="subagentDirectoryDetails">{agent.model ? <span>{agent.model}</span> : null}{date ? <time dateTime={date.toISOString()}>{date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time> : null}</span>
        </span><span className={`subagentState state-${state}${state === "running" || state === "dispatched" ? " subagentRunningShimmer" : ""}`}>{agentStateLabel[state]}</span>
      </button>;
    })
  ]), [groups, onSelect]);
  return <div className="subagentDirectoryBrowser">
    <div className="subagentDirectoryControls">
      <div className="subagentDirectoryFilters" role="tablist" aria-label="子代理分类">
        <button type="button" role="tab" aria-selected={view === "active"} onClick={() => setView("active")}>进行中{globalCounts ? ` · ${globalCounts.activeCount}` : ""}</button>
        <button type="button" role="tab" aria-selected={view === "history"} onClick={() => setView("history")}>历史{globalCounts ? ` · ${globalCounts.historyCount}` : ""}</button>
      </div>
      <label className="subagentDirectorySearch"><input type="search" aria-label="搜索子代理名称或模型" placeholder="搜索代理名称或模型" value={query} onChange={event => setQuery(event.target.value)} spellCheck={false} autoComplete="off" /></label>
    </div>
    <div className="subagentDirectoryStage">
      {renderLoading(loading, "正在读取子代理目录")}
      <VirtualConversation ref={virtualList} containerRef={list} historyRevision={historyRevision} threadKey={`${projectId}:${parentThreadId}:${view}:${search}`} virtualize className={`subagentDirectoryResults${loading ? " isFiltering" : ""}`} tabIndex={0} aria-label="子代理目录" aria-busy={loading || appending} inert={loading} shouldFollowEnd={() => false} estimateRowSize={index => entries[index]?.key?.toString().startsWith("date:") ? 34 : 47}
        onWheel={event => { if (event.deltaY > 0) downGesture.current = Date.now(); }}
        onTouchStart={event => { touchY.current = event.touches[0]?.clientY ?? 0; }}
        onTouchMove={event => { const next = event.touches[0]?.clientY; if (next !== undefined) { if (next < touchY.current - 3) downGesture.current = Date.now(); touchY.current = next; } }}
        onKeyDown={event => { if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) downGesture.current = Date.now(); }}
        onScroll={event => { const element = event.currentTarget; if (Date.now() - downGesture.current < 1800 && element.scrollHeight - element.scrollTop - element.clientHeight < 260) void loadMore(); }}>
        {entries}
        {!loading && !rows.length && !error ? <p className="subagentPanelEmpty" key="empty">{search ? "没有匹配的子代理。" : view === "active" ? "暂无进行中的子代理，已结束的记录保留在历史中。" : "暂无历史子代理记录。"}</p> : null}
      </VirtualConversation>
      <ToolReveal open={appending} className="subagentDirectoryPagingReveal"><div className="subagentDirectoryPaging" role="status">正在读取更早的代理…</div></ToolReveal>
    </div>
    {error ? <div className="subagentPanelError" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重新读取目录</button></div> : null}
  </div>;
}
