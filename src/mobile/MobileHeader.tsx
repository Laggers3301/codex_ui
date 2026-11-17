import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, PanelRight, ChevronDown } from "lucide-react";
import { useMobileLayer } from "./MobileLayerProvider";

/** Title tap reveals one compact row of the conversation controls (quota,
 * access, approval) under the bar, like the earlier phone header; no sheet. */
export function MobileHeader({ title, scope, sidebarOpen, workspaceOpen, onSidebar, onWorkspace, controls, openRequest, onOptionsClose }: {
  title: string; scope: string; sidebarOpen: boolean; workspaceOpen: boolean;
  onSidebar: () => void; onWorkspace: () => void; controls: ReactNode; openRequest: number; onOptionsClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLDivElement>(null), titleButton = useRef<HTMLButtonElement>(null), closed = useRef(onOptionsClose);
  closed.current = onOptionsClose;
  useEffect(() => setOpen(false), [scope]);
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);
  useEffect(() => { if (!open) closed.current(); }, [open]);
  useMobileLayer(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || row.current?.contains(target) || titleButton.current?.contains(target)
        || target.closest('dialog,[role="dialog"],.trackedQuotaDialog')) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  return <header className="mobileUiHeader" data-options={open ? "open" : undefined}>
    <button type="button" aria-label={sidebarOpen ? "收起侧边栏" : "展开侧边栏"} aria-expanded={sidebarOpen} onClick={onSidebar}><Menu size={20} /></button>
    <button ref={titleButton} className="mobileUiTitle" type="button" aria-label={`会话设置：${title}`} aria-expanded={open} aria-controls="conversation-header-controls" onClick={() => setOpen(value => !value)}><span>{title}</span><ChevronDown size={14} /></button>
    <button type="button" aria-label={workspaceOpen ? "隐藏右栏" : "显示右栏"} aria-expanded={workspaceOpen} onClick={onWorkspace}><PanelRight size={19} /></button>
    <div className="mobileUiHeaderOptions" ref={row} data-open={open || undefined} aria-hidden={!open} inert={!open}>{controls}</div>
  </header>;
}
