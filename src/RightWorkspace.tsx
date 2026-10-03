import { useEffect, useRef, useState, type ReactNode, type MouseEvent } from "react";
import { Browser, Terminal, FileCode, FileEditing, FileText, FolderOpen, LayoutOne, List, People, Plus, X, Target, Link, RightBar, Clock } from "./PanelIcons";
import "./rightWorkspace.css";

const icons = { overview: List, browser: Browser, terminal: Terminal, diff: FileCode, agents: People, remote: FolderOpen, goal: Target, schedules: Clock, outputs: FileText, sources: Link, preview: FileText, writing: FileEditing, panel: RightBar, plus: Plus, close: X, layout: LayoutOne };
export type WorkspaceIconName = keyof typeof icons;
export function WorkspaceIcon({ name }: { name: WorkspaceIconName }) {
  const Glyph = icons[name];
  return <span className="rightWorkspaceIcon" aria-hidden="true"><Glyph /></span>;
}
export type WorkspaceTab = { id: string; title: string; icon: WorkspaceIconName; content: ReactNode; onClose: () => void; closing?: boolean; attention?: boolean };
export type WorkspaceEntry = { id: string; title: string; detail?: string; icon: WorkspaceIconName; leading?: ReactNode; onOpen: () => void; disabled?: boolean; badge?: string };
export type WorkspaceSection = { title: string; entries: WorkspaceEntry[]; more?: { label: string; onOpen: () => void } };

export function WorkspaceOverview({ sections }: { sections: WorkspaceSection[] }) {
  return <div className="rightWorkspaceOverview"><div className="rightWorkspaceOverviewCard">
    {sections.filter(section => section.entries.length > 0).map(section => <section key={section.title}>
      <h3>{section.title}</h3>
      {section.entries.map(entry => <button type="button" className="rightWorkspaceEntry" key={entry.id} onClick={entry.onOpen} disabled={entry.disabled} title={entry.detail || entry.title}>
        {entry.leading ?? <WorkspaceIcon name={entry.icon} />}<span className="rightWorkspaceEntryText"><strong>{entry.title}</strong>{entry.detail ? <small>{entry.detail}</small> : null}</span>{entry.badge ? <em>{entry.badge}</em> : null}
      </button>)}
      {section.more ? <button type="button" className="rightWorkspaceMore" onClick={section.more.onOpen}>{section.more.label}</button> : null}
    </section>)}
  </div></div>;
}

export function RightWorkspace({ scope, open, active, width, tabs, overview, onSelect, onHide, onResize }: {
  scope: string;
  open: boolean; active: string; width: number; tabs: WorkspaceTab[]; overview: ReactNode;
  onSelect: (id: string) => void; onHide: () => void; onResize: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const tabList = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState<string[]>([]);
  const closeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => { setClosing([]); return () => { for (const timer of closeTimers.current.values()) clearTimeout(timer); closeTimers.current.clear(); }; }, [scope]);
  const closeTab = (tab: WorkspaceTab) => {
    if (tab.closing !== undefined) { tab.onClose(); return; }
    if (closeTimers.current.has(tab.id)) return;
    setClosing(current => [...current, tab.id]);
    closeTimers.current.set(tab.id, setTimeout(() => {
      closeTimers.current.delete(tab.id);
      tab.onClose();
      setClosing(current => current.filter(id => id !== tab.id));
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280));
  };
  const ids = tabs.map(tab => tab.id).join("|");
  useEffect(() => {
    if (active !== "overview" && !tabs.some(tab => tab.id === active)) onSelect(tabs.at(-1)?.id ?? "overview");
  }, [ids, active]);
  useEffect(() => {
    const selected = tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!selected || !tabList.current) return;
    // Scroll this strip only: scrollIntoView would move the conversation too.
    const list = tabList.current;
    const left = selected.offsetLeft;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (left + selected.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + selected.offsetWidth - list.clientWidth;
  }, [active, ids]);
  const selectByKey = (event: React.KeyboardEvent, index: number) => {
    const options = ["overview", ...tabs.map(tab => tab.id)];
    const next = event.key === "ArrowRight" ? (index + 1) % options.length : event.key === "ArrowLeft" ? (index + options.length - 1) % options.length : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); onSelect(options[next]);
    tabList.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus({ preventScroll: true });
  };
  return <aside className={`rightWorkspace diffReviewPanel${open ? " isOpen" : ""}${active === "overview" ? " overviewMode" : ""}`} style={{ width: open ? width : 0 }} aria-label="工作区右侧面板" aria-hidden={!open} inert={!open}>
    <div className="diffReviewResizeHandle" role="separator" aria-orientation="vertical" aria-label="拖动调整右栏宽度" onMouseDown={onResize} />
    <header className="rightWorkspaceBar">
      <div ref={tabList} className="rightWorkspaceTabs" role="tablist" aria-label="右栏窗口">
        <button className="rightWorkspaceTab rightWorkspaceHome" type="button" role="tab" id="right-tab-overview" aria-controls="right-pane-overview" aria-selected={active === "overview"} tabIndex={active === "overview" ? 0 : -1} title="会话概览" onClick={() => onSelect("overview")} onKeyDown={event => selectByKey(event, 0)}><WorkspaceIcon name="overview" /></button>
        {tabs.map((tab, index) => <div className={`rightWorkspaceTabGroup${active === tab.id ? " selected" : ""}${tab.closing || closing.includes(tab.id) ? " closing" : ""}`} key={tab.id}>
          <button type="button" role="tab" className="rightWorkspaceTab" id={`right-tab-${tab.id}`} aria-controls={`right-pane-${tab.id}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} title={tab.attention ? `${tab.title} · 等待批准` : tab.title} onClick={() => onSelect(tab.id)} onKeyDown={event => selectByKey(event, index + 1)}><WorkspaceIcon name={tab.icon} /><span>{tab.title}</span>{tab.attention ? <i className="rightWorkspaceAttention" aria-label="等待批准" /> : null}</button>
          <button className="rightWorkspaceTabClose" type="button" aria-label={`关闭${tab.title}窗口`} title={`关闭${tab.title}`} onClick={() => closeTab(tab)}><WorkspaceIcon name="close" /></button>
        </div>)}
      </div>
      <button type="button" className="rightWorkspaceControl" title="打开窗口" aria-label="打开右栏窗口" onClick={() => onSelect("overview")}><WorkspaceIcon name="plus" /></button>
      <button type="button" className="rightWorkspaceControl" title="隐藏右栏（Ctrl+Shift+B）" aria-label="隐藏右栏" onClick={onHide}><WorkspaceIcon name="panel" /></button>
    </header>
    <div className="rightWorkspaceStage">
      <section className={`rightWorkspacePane${active === "overview" ? " active" : ""}`} id="right-pane-overview" role="tabpanel" aria-labelledby="right-tab-overview" aria-hidden={active !== "overview"} inert={active !== "overview"}>{overview}</section>
      {tabs.map(tab => <section className={`rightWorkspacePane${active === tab.id ? " active" : ""}${tab.closing || closing.includes(tab.id) ? " closing" : ""}`} key={tab.id} id={`right-pane-${tab.id}`} role="tabpanel" aria-labelledby={`right-tab-${tab.id}`} aria-hidden={active !== tab.id} inert={active !== tab.id}>{tab.content}</section>)}
    </div>
  </aside>;
}
