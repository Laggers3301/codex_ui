import { useEffect, useLayoutEffect, useRef } from "react";
import { mobileHaptic } from "./mobileHaptics";

export function sidebarSwipeIntent(dx: number, dy: number, open: boolean): "wait" | "ignore" | "drag" {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < 7) return "wait";
  // A finger rarely leaves the glass on a straight line: the first few millimetres
  // wobble vertically. Only a clearly vertical, well-established motion is a scroll;
  // anything less is undecided, not a verdict (a wrong early verdict used to make the
  // swipe fail and left the touch to select the row under the finger).
  if (ay > ax * 1.2) return ay >= 12 ? "ignore" : "wait";
  if (open ? dx > 0 : dx < 0) return "ignore";
  return "drag";
}

/* Drawer motion, built the way native-feeling web apps do it:
 *  - every frame writes ONE inline `transform` on the drawer itself (and an
 *    opacity on its scrim). Nothing is written to :root, so no frame ever
 *    invalidates the style of the whole 3,000-node page;
 *  - the drawer is shown and moved by the DOM first, and the React state that
 *    mirrors it is committed only after the motion ends, so the expensive App
 *    re-render never sits between a finger/tap and the first moving frame;
 *  - `data-moving` marks the drawer while it moves: glass blur is off (a
 *    full-height backdrop-filter re-blurs the transcript every frame) and the
 *    layer is promoted; full glass returns at rest. */
type Parts = { panel: HTMLElement; backdrop: HTMLElement | null; workspace: HTMLElement | null };
const SETTLE_MS = 280;

/** Mobile-only drawer. Keep the system's outermost back-gesture strip free. */
export function useMobileSidebar(collapsed: boolean, change: (collapsed: boolean) => void, side: "left" | "right" = "left") {
  const sign = side === "left" ? 1 : -1;
  const state = useRef({ collapsed, change }); state.current = { collapsed, change };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const settling = useRef(false);
  const find = (): Parts | null => {
    const panel = side === "left" ? document.getElementById("conversation-sidebar") : document.querySelector<HTMLElement>(".rightWorkspace.diffReviewPanel");
    if (!panel) return null;
    return { panel, backdrop: side === "left" ? document.querySelector<HTMLElement>(".mobileSidebarBackdrop") : null, workspace: panel.closest<HTMLElement>(".workspace") };
  };
  // The DOM is the source of truth while a motion is running: React's mirror
  // state may lag the finger by a render.
  const isOpen = (p: Parts) => side === "left" ? !p.panel.classList.contains("collapsed") : Boolean(p.workspace?.classList.contains("diffPanelOpen"));
  const setShown = (p: Parts, open: boolean) => {
    if (side === "left") { p.panel.classList.toggle("collapsed", !open); p.backdrop?.classList.toggle("inactive", !open); }
    else p.workspace?.classList.toggle("diffPanelOpen", open);
  };
  // Left drawer: 0 = open, -width = closed. Right drawer is mirrored.
  const width = () => side === "left" ? Math.min(380, window.innerWidth * .92) : window.innerWidth;
  const place = (p: Parts, offset: number) => {
    p.panel.style.transform = `translate3d(${sign * offset}px,0,0)`;
    if (p.backdrop) p.backdrop.style.opacity = String(Math.max(0, Math.min(1, 1 + offset / width())) * .3);
  };
  const beginMotion = (p: Parts, animated: boolean) => {
    p.panel.dataset.moving = "";
    p.panel.style.transition = animated ? "" : "none";
    if (p.backdrop) p.backdrop.style.transition = animated ? "" : "none";
  };
  const clear = (p: Parts) => {
    delete p.panel.dataset.moving;
    for (const name of ["transform", "transition"]) p.panel.style.removeProperty(name);
    if (p.backdrop) for (const name of ["opacity", "transition"]) p.backdrop.style.removeProperty(name);
  };
  const reset = () => { const p = find(); if (p) clear(p); };
  // Keep the off-screen pose until React has committed the closed class.
  useLayoutEffect(() => { if (collapsed) { const p = find(); if (p) { setShown(p, false); clear(p); } } }, [collapsed]);
  const settle = (p: Parts, open: boolean, commit: boolean, version: number) => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    beginMotion(p, !reduced); place(p, open ? 0 : -width());
    settling.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (version !== generation.current) return;
      timer.current = null; settling.current = false;
      if (open) clear(p); else { setShown(p, false); clear(p); }
      if (commit && state.current.collapsed === open) state.current.change(!open);
    }, reduced ? 0 : SETTLE_MS + 20);
  };
  const setOpen = (open: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    const version = ++generation.current;
    if (!window.matchMedia("(max-width: 720px)").matches) { reset(); settling.current = false; state.current.change(!open); return; }
    const p = find();
    if (!p) {
      if (open) state.current.change(false);
      else timer.current = setTimeout(() => { if (version === generation.current) { timer.current = null; state.current.change(true); } }, SETTLE_MS);
      return;
    }
    mobileHaptic();
    if (open && !isOpen(p)) {
      beginMotion(p, false); place(p, -width()); setShown(p, true);
      void p.panel.offsetWidth; // commit the off-screen pose before animating
      requestAnimationFrame(() => { if (version === generation.current) settle(p, true, true, version); });
      // Safety net when rAF is throttled (hidden tab): never strand a revealed drawer.
      timer.current = setTimeout(() => { if (version === generation.current && !settling.current) settle(p, true, true, version); }, 120);
    } else settle(p, open, true, version);
  };
  useEffect(() => {
    let frame = 0, pendingOffset = 0, suppressClickUntil = 0;
    let drag: { x: number; y: number; open: boolean; active: boolean; dx: number; parts: Parts | null } | null = null;
    const paint = () => { frame = 0; if (drag?.parts) place(drag.parts, pendingOffset); };
    const start = (event: TouchEvent) => {
      if (!window.matchMedia("(max-width: 720px)").matches || event.touches.length !== 1 || settling.current) return;
      const target = event.target as Element;
      const touch = event.touches[0], parts = find();
      if (!parts) return;
      const open = isOpen(parts);
      const fromEdge = side === "left" ? touch.clientX : window.innerWidth - touch.clientX;
      // A drag that begins in the edge strip is a drawer gesture even over a
      // button, image or code block: past the 7px threshold it is never a tap,
      // and the transcript's right half is mostly such full-width content.
      const edgeStrip = !open && fromEdge <= 56;
      if (target.closest(edgeStrip ? "input,textarea,select,[contenteditable],[role=dialog],.modalScrim" : "input,textarea,select,a,pre,table,[contenteditable],canvas,iframe,[role=dialog],.modalScrim,.rightWorkspaceTabs")) return;
      const ownPanel = side === "left" ? "#conversation-sidebar,.mobileSidebarBackdrop" : ".rightWorkspace";
      if (!edgeStrip && target.closest("button") && !target.closest(ownPanel)) return;
      if (target.closest(side === "left" ? ".rightWorkspace" : "#conversation-sidebar")) return;
      if (window.getSelection()?.toString()) return;
      // A closing drag belongs to the already-open panel, not its opposite.
      if (!open && (side === "left" ? document.querySelector(".workspace.diffPanelOpen") : document.querySelector(".threadList:not(.collapsed)"))) return;
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone;
      if (!open && (fromEdge < (standalone ? 0 : 20) || fromEdge > window.innerWidth / 2)) return;
      drag = { x: touch.clientX, y: touch.clientY, open, active: false, dx: 0, parts };
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
        beginMotion(drag.parts!, false);
        if (!drag.open) { place(drag.parts!, -width()); setShown(drag.parts!, true); }
      }
      // .threadColumn uses touch-action: pan-y pinch-zoom. Horizontal drags
      // belong to us; vertical scrolling stays on the browser compositor.
      // A permanent non-passive touchmove listener forces every scroll frame
      // to wait for JS, especially noticeable under mobile power throttling.
      drag.dx = dx;
      pendingOffset = Math.max(-width(), Math.min(0, (drag.open ? 0 : -width()) + dx));
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const finish = (cancelled = false) => {
      cancelAnimationFrame(frame); frame = 0;
      if (!drag?.active) { drag = null; return; }
      suppressClickUntil = performance.now() + 400; // a recognised swipe never also selects the row under the finger
      const wasOpen = drag.open, parts = drag.parts!;
      const open = cancelled ? wasOpen : Math.abs(drag.dx) > Math.min(90, width() * .25) ? !wasOpen : wasOpen;
      drag = null;
      // Commit React's mirror only when the result differs from what it holds.
      settle(parts, open, true, ++generation.current);
    };
    const swallowClick = (event: Event) => { if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); } };
    const end = (event: TouchEvent) => { if (drag?.active && event.cancelable) event.preventDefault(); finish(); }, cancel = () => finish(true);
    const resize = () => {
      drag = null; cancelAnimationFrame(frame); frame = 0; if (timer.current) clearTimeout(timer.current);
      generation.current++; settling.current = false;
      const p = find(); if (p) { setShown(p, !state.current.collapsed); clear(p); }
    };
    const surface = document.querySelector(".threadColumn") ?? document;
    surface.addEventListener("touchstart", start as EventListener, { passive: true, capture: true });
    surface.addEventListener("touchmove", move as EventListener, { passive: true, capture: true });
    surface.addEventListener("touchend", end as EventListener, { passive: false, capture: true });
    surface.addEventListener("touchcancel", cancel, true);
    surface.addEventListener("click", swallowClick, true);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame); surface.removeEventListener("touchstart", start as EventListener, true); surface.removeEventListener("touchmove", move as EventListener, true); surface.removeEventListener("touchend", end as EventListener, true); surface.removeEventListener("touchcancel", cancel, true); surface.removeEventListener("click", swallowClick, true); window.removeEventListener("resize", resize);
      if (timer.current) clearTimeout(timer.current); generation.current++; settling.current = false; reset();
    };
  }, []);
  return setOpen;
}
