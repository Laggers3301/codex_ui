import { useEffect, useRef } from "react";

export function sidebarSwipeIntent(dx: number, dy: number, open: boolean): "wait" | "ignore" | "drag" {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 7) return "wait";
  if (Math.abs(dy) > Math.abs(dx) * .8 || (open ? dx > 0 : dx < 0)) return "ignore";
  return "drag";
}

/** Mobile-only drawer. Keep the system's outermost back-gesture strip free. */
export function useMobileSidebar(collapsed: boolean, change: (collapsed: boolean) => void, side: "left" | "right" = "left") {
  const sign = side === "left" ? 1 : -1;
  const draggingKey = side === "left" ? "sidebarDragging" : "rightPanelDragging";
  const offsetKey = side === "left" ? "--mobile-sidebar-offset" : "--mobile-right-panel-offset";
  const progressKey = side === "left" ? "--mobile-sidebar-progress" : "--mobile-right-panel-progress";
  const state = useRef({ collapsed, change }); state.current = { collapsed, change };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const reset = () => {
    const root = document.documentElement;
    delete root.dataset[draggingKey];
    root.style.removeProperty(offsetKey);
    root.style.removeProperty(progressKey);
  };
  const width = () => side === "left" ? Math.min(360, window.innerWidth * .88) : window.innerWidth;
  const setOpen = (open: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    const version = ++generation.current;
    if (!window.matchMedia("(max-width: 720px)").matches) { reset(); state.current.change(!open); return; }
    const root = document.documentElement;
    if (open) {
      root.dataset[draggingKey] = "true";
      root.style.setProperty(offsetKey, `${-sign * width()}px`);
      root.style.setProperty(progressKey, "0");
      state.current.change(false);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (version !== generation.current) return;
        delete root.dataset[draggingKey];
        root.style.setProperty(offsetKey, "0px");
        root.style.setProperty(progressKey, "1");
      }));
    } else {
      delete root.dataset[draggingKey];
      root.style.setProperty(offsetKey, `${-sign * width()}px`);
      root.style.setProperty(progressKey, "0");
      timer.current = setTimeout(() => { state.current.change(true); reset(); }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 280);
    }
  };
  useEffect(() => {
    let frame = 0, pendingOffset = 0;
    const paint = () => {
      frame = 0;
      document.documentElement.style.setProperty(offsetKey, `${sign * pendingOffset}px`);
      document.documentElement.style.setProperty(progressKey, String(1 + pendingOffset / width()));
    };
    let drag: { x: number; y: number; open: boolean; active: boolean; dx: number } | null = null;
    const start = (event: TouchEvent) => {
      if (!window.matchMedia("(max-width: 720px)").matches || event.touches.length !== 1) return;
      const target = event.target as Element;
      if (target.closest("input,textarea,select,a,pre,table,[contenteditable],canvas,iframe,[role=dialog],.modalScrim,.rightWorkspaceTabs")) return;
      const ownPanel = side === "left" ? "#conversation-sidebar,.mobileSidebarBackdrop" : ".rightWorkspace";
      if (target.closest("button") && !target.closest(ownPanel)) return;
      if (target.closest(side === "left" ? ".rightWorkspace" : "#conversation-sidebar")) return;
      if (window.getSelection()?.toString()) return;
      const touch = event.touches[0], open = !state.current.collapsed;
      // A closing drag belongs to the already-open panel, not its opposite.
      if (!open && (side === "left" ? document.querySelector(".workspace.diffPanelOpen") : document.querySelector(".threadList:not(.collapsed)"))) return;
      const fromEdge = side === "left" ? touch.clientX : window.innerWidth - touch.clientX;
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone;
      if (!open && (fromEdge < (standalone ? 0 : 20) || fromEdge > window.innerWidth / 2)) return;
      drag = { x: touch.clientX, y: touch.clientY, open, active: false, dx: 0 };
    };
    const move = (event: TouchEvent) => {
      if (!drag || event.touches.length !== 1) return;
      const dx = sign * (event.touches[0].clientX - drag.x), dy = event.touches[0].clientY - drag.y;
      if (!drag.active) {
        const intent = sidebarSwipeIntent(dx, dy, drag.open);
        if (intent === "ignore") { drag = null; return; }
        if (intent === "wait") return;
        if (timer.current) clearTimeout(timer.current);
        generation.current++;
        drag.active = true;
        document.documentElement.dataset[draggingKey] = "true";
        if (!drag.open) {
          document.documentElement.style.setProperty(offsetKey, `${-sign * width()}px`);
          document.documentElement.style.setProperty(progressKey, '0');
          state.current.change(false);
        }
      }
      if (event.cancelable) event.preventDefault();
      drag.dx = dx;
      const offset = Math.max(-width(), Math.min(0, (drag.open ? 0 : -width()) + dx));
      pendingOffset = offset;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const finish = (cancelled = false) => {
      cancelAnimationFrame(frame); frame = 0;
      if (!drag?.active) { drag = null; return; }
      const open = cancelled ? drag.open : Math.abs(drag.dx) > Math.min(90, width() * .25) ? !drag.open : drag.open;
      drag = null;
      if (open) {
        delete document.documentElement.dataset[draggingKey];
        document.documentElement.style.setProperty(offsetKey, "0px");
        document.documentElement.style.setProperty(progressKey, "1");
      } else setOpen(false);
    };
    const end = (event: TouchEvent) => { if (drag?.active && event.cancelable) event.preventDefault(); finish(); }, cancel = () => finish(true);
    const resize = () => { drag = null; cancelAnimationFrame(frame); frame = 0; if (timer.current) clearTimeout(timer.current); generation.current++; reset(); };
    const surface = document.querySelector(".threadColumn") ?? document;
    surface.addEventListener("touchstart", start as EventListener, { passive: true, capture: true });
    surface.addEventListener("touchmove", move as EventListener, { passive: false, capture: true });
    surface.addEventListener("touchend", end as EventListener, { passive: false, capture: true });
    surface.addEventListener("touchcancel", cancel, true);
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(frame); surface.removeEventListener("touchstart", start as EventListener, true); surface.removeEventListener("touchmove", move as EventListener, true); surface.removeEventListener("touchend", end as EventListener, true); surface.removeEventListener("touchcancel", cancel, true); window.removeEventListener("resize", resize); if (timer.current) clearTimeout(timer.current); generation.current++; reset(); };
  }, []);
  return setOpen;
}
