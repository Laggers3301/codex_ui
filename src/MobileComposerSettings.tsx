import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import "./mobileComposerSettings.css";

/** Reuse the actual controls and callbacks; desktop keeps its original markup. */
export function MobileComposerSettings({ mobile, label, scope, context, speed, tasks, model }: {
  mobile: boolean; label: string; scope: string;
  context?: ReactNode; speed?: ReactNode; tasks?: ReactNode; model: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDialogElement>(null);
  const closePanel = (immediate = false) => {
    clearTimeout(closeTimer.current);
    const finish = () => { panel.current?.close(); setOpen(false); setClosing(false); };
    if (immediate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
    setClosing(true);
    closeTimer.current = setTimeout(finish, 200);
  };
  useEffect(() => {
    clearTimeout(closeTimer.current); setClosing(false); setOpen(false);
    return () => clearTimeout(closeTimer.current);
  }, [scope, mobile]);
  useEffect(() => {
    if (!mobile) return;
    if (!open) { panel.current?.close(); return; }
    panel.current?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; panel.current?.close(); };
  }, [open, mobile]);
  useEffect(() => {
    if (!open) return;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    panel.current?.querySelector<HTMLButtonElement>('[aria-label="关闭会话设置"]')?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      // Nested model/task dialogs own their Escape and keyboard navigation.
      if (!panel.current?.contains(document.activeElement) || panel.current.querySelector('.groupedModelMenu')) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closePanel(); }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [open]);
  // Desktop order, left to right: tasks, context, speed (⚡), model.
  if (!mobile) return <>{tasks}{context}{speed}{model}</>;
  return <>
    <button ref={trigger} className="mobileComposerSettingsTrigger" type="button" aria-label="会话设置" aria-haspopup="dialog" aria-expanded={open} onClick={() => { clearTimeout(closeTimer.current); setClosing(false); setOpen(true); }}>
      <span>{label}</span><ChevronDown size={14} />
    </button>
    {createPortal(<dialog ref={panel} className="mobileComposerSettingsPanel" data-closing={closing || undefined} aria-label="会话设置"
      onCancel={event => { event.preventDefault(); event.stopPropagation(); closePanel(); }}
      onClose={event => { if (!event.currentTarget.open) { clearTimeout(closeTimer.current); setClosing(false); setOpen(false); } }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientY < rect.top || event.clientX < rect.left || event.clientX > rect.right) closePanel();
      }}>
        <div className="mobileComposerSettingsHandle" aria-hidden="true" />
        <header><h2>会话设置</h2><button type="button" aria-label="关闭会话设置" onClick={() => closePanel()}><X size={20} /></button></header>
        <div className="mobileComposerSettingsGroups" onClickCapture={event => {
          // Leave the native top layer before a child opens its own dialog,
          // so native focus restoration cannot steal that dialog's focus.
          if ((event.target as Element).closest('.v2ContextStatusButton,.conversationTasksTrigger')) closePanel(true);
        }}>
          <div className="mobileComposerSettingsControls">{model}</div>
          {speed ? <div className="mobileComposerSettingsControls">{speed}</div> : null}
          {context || tasks ? <div className="mobileComposerSettingsControls">{context}{tasks}</div> : null}
        </div>
    </dialog>, document.body)}
  </>;
}
