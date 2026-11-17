import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useMobileLayer } from "./MobileLayerProvider";

/** Phone-only sheet: a single focus/exit/back contract, no business requests. */
export function MobileSheet({ title, open, onClose, children, keepMounted = false }: { title: string; open: boolean; onClose: () => void; children: ReactNode; keepMounted?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), heading = useId();
  useMobileLayer(open, onClose);
  useEffect(() => {
    const node = dialog.current; if (!node || !open) return;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node.showModal();
    return () => { node.close(); if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }, [open]);
  return createPortal(<dialog className="mobileUiSheet" ref={dialog} aria-labelledby={heading}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientY < box.top || event.clientY > box.bottom || event.clientX < box.left || event.clientX > box.right) onClose();
    }}>
    <div className="mobileUiSheetHandle" aria-hidden="true" />
    <header><h2 id={heading}>{title}</h2><button type="button" aria-label={`关闭${title}`} onClick={onClose}><X size={20} /></button></header>
    <div className="mobileUiSheetBody">{open || keepMounted ? children : null}</div>
  </dialog>, document.body);
}
