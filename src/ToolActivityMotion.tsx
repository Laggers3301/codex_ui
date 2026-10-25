import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./toolActivityMotion.css";

export const TOOL_ARRIVAL_STAGGER_MS = 32;
export const TOOL_ARRIVAL_MAX_DELAY_MS = 160;
export function nextToolCount(current: number, target: number): number {
  return current >= target ? target : Math.min(target, current + Math.max(1, Math.ceil((target - current) / 4)));
}

/** Presentation only: no event buffering, model backpressure or growing queue. */
export function RollingToolCount({ count, arrive = false }: { count: number; arrive?: boolean }) {
  const initial = arrive ? Math.min(1, count) : count;
  const [{ value, old }, setDisplay] = useState({ value: initial, old: initial });
  const valueRef = useRef(initial);
  const counterRef = useRef<HTMLSpanElement>(null);
  // Paint the digit from the header's single gradient, in header coordinates.
  // Geometry changes only on layout/resize; animation remains entirely in CSS.
  useLayoutEffect(() => {
    const counter = counterRef.current;
    const title = counter?.closest<HTMLElement>(".toolBundleTitleLabel");
    if (!counter || !title) return;
    const measure = () => {
      const header = title.getBoundingClientRect();
      const digit = counter.getBoundingClientRect();
      title.style.setProperty("--tool-shimmer-width", `${header.width}px`);
      counter.style.setProperty("--tool-shimmer-offset", `${digit.left - header.left}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(title);
    observer.observe(counter);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || count < valueRef.current) {
      valueRef.current = count;
      setDisplay({ value: count, old: count });
      return;
    }
    // At most 480ms of catch-up, even if a burst contains thousands of calls.
    let steps = 0;
    const timer = window.setInterval(() => {
      const next = ++steps >= 6 ? count : nextToolCount(valueRef.current, count);
      const old = valueRef.current;
      valueRef.current = next;
      setDisplay({ value: next, old });
      if (next === count) window.clearInterval(timer);
    }, 80);
    if (valueRef.current === count) window.clearInterval(timer);
    return () => window.clearInterval(timer);
  }, [count]);
  return <span ref={counterRef} className="toolRollingCount" aria-label={String(count)} data-target-count={count}>
    <span className="toolRollingCountSizer" aria-hidden="true">{Math.max(count, value)}</span>
    <span key={value} className="toolRollingCountLayers" aria-hidden="true" data-moving={old !== value}>
      {old !== value ? <span className="toolRollingCountOld"><span className="toolCountGlyph">{old}</span></span> : null}
      <span className="toolRollingCountNew"><span className="toolCountGlyph">{value}</span></span>
    </span>
  </span>;
}

/** Restored history/opening a disclosure paints in place; only new rows animate. */
export function ToolArrivalList({ itemKeys, arrive = false, children, onClick }: {
  itemKeys: string[]; arrive?: boolean; children: ReactNode; onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set(arrive ? [] : itemKeys));
  const animations = useRef(new Set<Animation>());
  useLayoutEffect(() => {
    const added = new Set(itemKeys.filter(key => !seen.current.has(key)));
    seen.current = new Set(itemKeys);
    // Completion/shimmer is unrelated to arrival. A completed row can reach
    // an already open list through a batched event or history reconciliation.
    // Initial restored rows are already in `seen`, so they do not replay.
    if (!added.size || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let index = 0;
    const step = Math.min(TOOL_ARRIVAL_STAGGER_MS, TOOL_ARRIVAL_MAX_DELAY_MS / Math.max(1, added.size - 1));
    for (const row of Array.from(root.current?.children ?? [])) {
      if (!(row instanceof HTMLElement) || !added.has(row.dataset.toolEntryKey ?? "")) continue;
      const animation = row.animate([
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "translateY(0)" }
      ], { duration: 220, delay: Math.min(index++ * step, TOOL_ARRIVAL_MAX_DELAY_MS), easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" });
      animations.current.add(animation);
      animation.finished.catch(() => {}).finally(() => animations.current.delete(animation));
    }
  });
  useEffect(() => () => { for (const animation of animations.current) animation.cancel(); animations.current.clear(); }, []);
  return <div ref={root} className="toolBundleEntries" onClick={onClick}>{children}</div>;
}
