import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { ComposerLongText, type ComposerLongTextHandle } from "../ComposerLongText";
import { MobileSheet } from "./MobileSheet";
import { useMobileLayer } from "./MobileLayerProvider";
import { mobileShapeHaptic } from "../mobileHaptics";

const pages = { session: "会话操作", workspace: "工作区工具", settings: "设置与用量" };
const groupFor = (id: string) => ["goal", "export", "send-markdown", "archive-list", "archive-current"].includes(id) ? "session"
  : ["writing", "worktree", "terminal", "browser", "hooks"].includes(id) ? "workspace"
  : ["settings", "quota", "leaderboard", "haptics"].includes(id) ? "settings" : "root";

export type MobileAction = { id: string; label: string; action: () => void; disabled?: boolean; active?: boolean };
export function MobileComposer({ scope, userId, value, onChange, editor, activity, extras, chips, model, actions, menu, fileInput, active = false }: {
  scope: string; userId: string; value: string; onChange: (value: string) => void;
  editor: ReactNode; activity: ReactNode; extras: ReactNode; chips: ReactNode;
  model: ReactNode; actions: ReactNode; menu: MobileAction[]; fileInput: ReactNode;
  /** Anything in the composer (text, attachments, skills, plan mode...). */
  active?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null), [focused, setFocused] = useState(false), [menuOpen, setMenuOpen] = useState(false);
  const longText = useRef<ComposerLongTextHandle>(null);
  const [menuPage, setMenuPage] = useState("root");
  useMobileLayer(menuOpen && menuPage !== "root", () => setMenuPage("root"));
  // The box is open while the field has focus OR holds anything at all, so text, an
  // attached image/file or a voice transcript lifts the capsule by itself. Its height then
  // follows the content up to the editor's own max-height, after which the text scrolls.
  const expanded = focused || active;
  // Capsule <-> box is one bottom-anchored morph (FLIP): the box height and the editor's
  // position animate from their previous layout. The "before" geometry is read while
  // rendering - the DOM still shows the old shape - so it works for focus taps and for
  // content-driven changes alike.
  const shown = useRef(expanded), before = useRef<{ height: number; editor?: DOMRect } | null>(null), morphs = useRef<Animation[]>([]);
  if (shown.current !== expanded) {
    shown.current = expanded;
    const node = root.current;
    before.current = node ? { height: node.getBoundingClientRect().height, editor: node.querySelector(".mobileUiComposerEditor")?.getBoundingClientRect() } : null;
  }
  useLayoutEffect(() => {
    const node = root.current, from = before.current; before.current = null;
    for (const animation of morphs.current) animation.cancel();
    morphs.current = [];
    if (!node || !from) return;
    mobileShapeHaptic();
    if (typeof node.animate !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timing = { duration: 380, easing: "cubic-bezier(.32,.72,0,1)" }, height = node.getBoundingClientRect().height;
    if (Math.abs(height - from.height) >= 1) morphs.current.push(node.animate([{ height: `${from.height}px` }, { height: `${height}px` }], timing));
    const editor = node.querySelector<HTMLElement>(".mobileUiComposerEditor"), rect = editor?.getBoundingClientRect();
    if (editor && rect && from.editor) morphs.current.push(editor.animate([{ transform: `translate(${from.editor.left - rect.left}px,${from.editor.top - rect.top}px)` }, { transform: "none" }], timing));
    if (expanded) for (const part of node.querySelectorAll<HTMLElement>(".mobileUiComposerModel,.mobileUiComposerActivity,.mobileUiComposerExtras"))
      morphs.current.push(part.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 90, easing: "ease-out", fill: "backwards" }));
    if (!morphs.current.length) return;
    node.dataset.morphing = "";
    const settled = morphs.current;
    void Promise.allSettled(settled.map(animation => animation.finished)).then(() => { if (morphs.current === settled) delete node.dataset.morphing; });
  }, [expanded]);
  useEffect(() => { setMenuOpen(false); setFocused(false); }, [scope]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || root.current?.contains(event.target) || event.target.closest('dialog,[role="dialog"],.queuedSubmissionStrip,.mobileUiQueuedSubmissionStrip')) return;
      setFocused(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, []);
  return <>
    <div className="mobileUiComposerSurface" ref={root} data-expanded={expanded || undefined}
      onFocusCapture={event => { if ((event.target as Element).closest('.composerRichInput')) setFocused(true); }}>
      <div className="mobileUiComposerActivity">{activity}</div>
      <div className="mobileUiComposerExtras">{extras}{chips}</div>
      <div className="mobileUiComposerEditor" onClick={() => {
        const input = root.current?.querySelector<HTMLElement>('.composerRichInput[contenteditable="true"]');
        // Focus within the real tap, so iOS can open its keyboard on first tap.
        if (input && document.activeElement !== input) input.focus({ preventScroll: true });
      }}>{editor}</div>
      <div className="mobileUiComposerToolbar">
        <button className="mobileUiPlus" type="button" aria-label="添加文件和功能" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => { setMenuPage("root"); setMenuOpen(true); }}><Plus size={20} /></button>
        <div className="mobileUiComposerModel">{model}</div>
        {actions}
      </div>
      {fileInput}
    </div>
    <ComposerLongText key={scope} ref={longText} hideTrigger userId={userId} value={value} onChange={onChange}
      onClose={() => root.current?.querySelector<HTMLButtonElement>('.mobileUiPlus')?.focus({ preventScroll: true })} />
    <MobileSheet title="添加与操作" open={menuOpen} onClose={() => setMenuOpen(false)}>
      <div className="mobileUiActionList">
        {menuPage !== "root" ? <button type="button" onClick={() => setMenuPage("root")}>‹ 返回</button> : null}
        {menuPage === "root" ? <button type="button" onClick={() => { setMenuOpen(false); longText.current?.open(); }}>长文本输入</button> : null}
        {menu.filter(item => groupFor(item.id) === menuPage).map(item => <button key={item.id} type="button" disabled={item.disabled} aria-pressed={item.active} onClick={() => { setMenuOpen(false); item.action(); }}>{item.label}{item.active ? <span aria-hidden="true">✓</span> : null}</button>)}
        {menuPage === "root" ? Object.entries(pages).map(([id, label]) => <button key={id} type="button" onClick={() => setMenuPage(id)}>{label}<span aria-hidden="true">›</span></button>) : null}
      </div>
    </MobileSheet>
  </>;
}
