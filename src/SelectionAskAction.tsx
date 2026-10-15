import { forwardRef, memo, useEffect, useImperativeHandle, useState } from "react";
import { MessageSquare } from "lucide-react";

export interface SelectionAskActionHandle { dismiss(): void; }
type Action = { text: string; left: number; top: number };

/** Selection changes are frequent browser events, not conversation updates.
 * Keep their tiny overlay local so dragging never re-renders either transcript. */
export const SelectionAskAction = memo(forwardRef<SelectionAskActionHandle, {
  onAsk: (text: string, left: number, top: number) => void;
  scope: string;
}>(function SelectionAskAction({ onAsk, scope }, ref) {
  const [action, setAction] = useState<Action | null>(null);
  useImperativeHandle(ref, () => ({ dismiss: () => setAction(null) }), []);
  useEffect(() => { setAction(null); }, [scope]);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const ancestor = range?.commonAncestorContainer;
      const element = ancestor instanceof Element ? ancestor : ancestor?.parentElement;
      if (element?.closest(".composer, .temporaryAskPanel, .globalSearchDialog, .writingWorkbench") || !text || text.length > 6000 || selection?.isCollapsed) {
        setAction(null);
        return;
      }
      const rect = range?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return;
      const next = {
        text,
        left: Math.min(Math.max(rect.left + rect.width / 2 - 78, 12), window.innerWidth - 190),
        top: Math.min(rect.bottom + 8, window.innerHeight - 54),
      };
      setAction(current => current?.text === next.text && current.left === next.left && current.top === next.top ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const released = (event: Event) => {
      if (!(event.target as HTMLElement | null)?.closest(".selectionAskButton")) schedule();
    };
    document.addEventListener("selectionchange", schedule, true);
    document.addEventListener("mouseup", released, true);
    document.addEventListener("pointerup", released, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule, true);
      document.removeEventListener("mouseup", released, true);
      document.removeEventListener("pointerup", released, true);
    };
  }, []);
  return action ? <button className="selectionAskButton" type="button" style={{ left: action.left, top: action.top }}
    onMouseDown={event => event.preventDefault()} onClick={() => { setAction(null); onAsk(action.text, action.left, action.top); }}>
    <MessageSquare size={14} /> 在侧边提问
  </button> : null;
}));
