import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { ComposerGlassMaterial } from "./ComposerGlassMaterial";
import type { QueuedSubmission } from "./queuedSubmissions";
import "./queuedMessages.css";

interface Props {
  mobile?: boolean;
  entries: QueuedSubmission[];
  fallbackEntry: QueuedSubmission;
  closing: boolean;
  canSteer: boolean;
  textFor: (entry: QueuedSubmission) => string;
  onSteer: (entry: QueuedSubmission) => void;
  onRemove: (entry: QueuedSubmission) => void;
  onSave: (entry: QueuedSubmission, text: string) => boolean;
  onOpenSideChat: (entry: QueuedSubmission) => void;
}

export function QueuedMessages({ mobile = false, entries, fallbackEntry, closing, canSteer, textFor, onSteer, onRemove, onSave, onOpenSideChat }: Props) {
  // Keep queue behavior shared, but do not inherit desktop typography or glass.
  const name = (part: string) => mobile ? `mobileUi${part[0].toUpperCase()}${part.slice(1)}` : part;
  const [expanded, setExpanded] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const showAll = expanded && entries.length > 1;
  const rows = showAll ? entries : [entries[0] ?? fallbackEntry];
  const menuEntry = entries.find(entry => entry.id === menuId);
  useEffect(() => {
    if (!menuId) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenuId(null); };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [menuId]);
  function save(entry: QueuedSubmission) {
    if (editText.trim() && onSave(entry, editText)) setEditingId(null);
  }
  const toggle = <button className={name("queuedQueueToggle")} type="button" aria-expanded={showAll} aria-controls={listId}
    onClick={() => { setExpanded(!showAll); setMenuId(null); }}>
    {showAll ? "收起队列" : "展开队列"} · {entries.length} 条 <ChevronDown size={12} aria-hidden="true" />
  </button>;
  return <div ref={root} className={`${name("queuedSubmissionStrip")}${showAll ? " expanded" : ""}${closing ? " closing" : ""}`} role="region" aria-label="排队发送的消息" aria-hidden={closing} inert={closing}
    onPointerDown={event => {
      // Keep the mobile composer from folding between button press and release.
      if (editingId && rows.some(entry => entry.id === editingId) && event.target instanceof Element && event.target.closest("button")) event.preventDefault();
    }}
    onKeyDown={event => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        event.preventDefault(); event.stopPropagation(); setMenuId(null); setEditingId(null); setExpanded(false);
      }
    }}>
    {showAll ? <div className={name("queuedQueueHeader")}>{toggle}</div> : null}
    <div className={name("queuedSubmissionList")} id={listId} role="list">
      {rows.map((entry, index) => <div className={name("queuedSubmission")} key={entry.id} data-queued-id={entry.id} role="listitem" aria-label={`第 ${index + 1} 条排队消息`}>
        {editingId === entry.id ? <>
          <input className={name("queuedEditInput")} value={editText} onChange={event => setEditText(event.target.value)} onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditingId(null); }
            if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); save(entry); }
          }} autoFocus aria-label={`编辑第 ${index + 1} 条排队消息`} />
          <button className={name("queuedSteerButton")} type="button" onClick={() => save(entry)} disabled={!editText.trim()}>保存</button>
          <button className={name("queuedIconButton")} type="button" onClick={() => setEditingId(null)} aria-label="取消编辑"><X size={mobile ? 16 : 13} /></button>
        </> : <>
          {!showAll && entries.length > 1 ? toggle : <span className={name("queuedSubmissionLabel")}>{entry.id.startsWith("pending:") ? "排队中" : showAll ? `#${index + 1}` : "已排队"}</span>}
          <span className={name("queuedSubmissionText")} title={textFor(entry)}>{textFor(entry) || "附件或技能消息"}</span>
          {canSteer ? <button className={name("queuedSteerButton")} type="button" disabled={entry.id.startsWith("pending:")} onClick={() => { setMenuId(null); onSteer(entry); }}>调整方向</button> : null}
          {!entry.id.startsWith("pending:") ? <>
            <button className={name("queuedIconButton")} type="button" aria-label={`移除第 ${index + 1} 条排队消息`} title="移除排队消息" onClick={() => onRemove(entry)}><X size={mobile ? 16 : 13} /></button>
            <button className={name("queuedIconButton")} type="button" aria-label={`第 ${index + 1} 条排队消息的更多操作`} aria-expanded={menuId === entry.id} onClick={() => setMenuId(menuId === entry.id ? null : entry.id)}>⋯</button>
          </> : null}
        </>}
      </div>)}
    </div>
    {!mobile ? <ComposerGlassMaterial variant="topbar" /> : null}
    {menuEntry ? <div className={name("queuedSubmissionMenu")} aria-label="所选排队消息的操作">
      <span className={name("queuedMenuSelection")}>第 {entries.findIndex(entry => entry.id === menuEntry.id) + 1} 条 · {textFor(menuEntry)}</span>
      <button type="button" onClick={() => { setEditText(textFor(menuEntry)); setEditingId(menuEntry.id); setMenuId(null); }}>编辑消息</button>
      <button type="button" onClick={() => { onOpenSideChat(menuEntry); setMenuId(null); }}>在侧边聊天中打开</button>
      <button type="button" onClick={() => { onRemove(menuEntry); setMenuId(null); }}>关闭排队</button>
    </div> : null}
  </div>;
}
