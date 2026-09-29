import { useEffect, useRef, useState, type ReactNode } from "react";

/** Keep the closing content mounted until both height and opacity settle. */
export function ToolReveal({
  open,
  children,
  className = "",
  settleMs = 300
}: {
  open: boolean;
  children: ReactNode | (() => ReactNode);
  className?: string;
  settleMs?: number;
}) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  const initialEffect = useRef(true);
  useEffect(() => {
    // Restored/open disclosures should paint in place on page load. Animate only
    // an actual user-driven change after this component has mounted.
    if (initialEffect.current) {
      initialEffect.current = false;
      return;
    }
    let frame = 0;
    let secondFrame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (open) {
      setMounted(true);
      frame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timer = setTimeout(() => setMounted(false), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : settleMs);
    }
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame); clearTimeout(timer); };
  }, [open, settleMs]);
  return <div className={`toolReveal${className ? ` ${className}` : ""}${visible && open ? " isOpen" : ""}`} aria-hidden={!open} inert={!open}>
    <div className="toolRevealClip">{mounted ? (typeof children === "function" ? children() : children) : null}</div>
  </div>;
}
