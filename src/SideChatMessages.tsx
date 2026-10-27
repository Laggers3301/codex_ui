import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Follow only this transcript's content, and leave a reader's scroll position alone. */
export function SideChatMessages({ conversationId, requestId, children }: { conversationId: string; requestId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let following = true, lastTop = element.scrollTop, touchY: number | null = null;
    let frame: number | null = null;
    const pause = () => {
      following = false;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };
    const follow = () => {
      frame = null;
      if (!following) return;
      // Scroll this container directly; scrollIntoView can also move ancestors.
      element.scrollTop = element.scrollHeight;
      lastTop = element.scrollTop;
    };
    const schedule = () => { if (following && frame === null) frame = requestAnimationFrame(follow); };
    const scroll = () => {
      const top = element.scrollTop;
      if (element.scrollHeight - element.clientHeight - top <= 2) following = true;
      else if (top < lastTop - 1) pause();
      lastTop = top;
    };
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) pause(); };
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pause();
    };
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
    const touchMove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY ?? null;
      if (next !== null && touchY !== null && next > touchY) pause();
      touchY = next;
    };
    const resize = new ResizeObserver(schedule);
    const observed = new Set<Element>();
    const watchMessages = () => {
      for (const child of observed) if (child.parentElement !== element) { resize.unobserve(child); observed.delete(child); }
      for (const child of element.children) if (!observed.has(child)) { resize.observe(child); observed.add(child); }
    };
    const mutations = new MutationObserver(() => { watchMessages(); schedule(); });
    resize.observe(element);
    watchMessages();
    mutations.observe(element, { childList: true, characterData: true, subtree: true });
    element.addEventListener("scroll", scroll, { passive: true });
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("keydown", key);
    element.addEventListener("touchstart", touchStart, { passive: true });
    element.addEventListener("touchmove", touchMove, { passive: true });
    // Opening a side chat or explicitly sending a new question starts at the end.
    follow();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      element.removeEventListener("scroll", scroll);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("keydown", key);
      element.removeEventListener("touchstart", touchStart);
      element.removeEventListener("touchmove", touchMove);
    };
  }, [conversationId, requestId]);
  return <div ref={ref} className="temporaryAskMessages messages">{children}</div>;
}
