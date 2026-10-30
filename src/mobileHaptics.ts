let lastPulse = -Infinity;

/** Progressive enhancement only: no timers, hidden switches or network calls. */
export function mobileHaptic(now = performance.now()): boolean {
  if (typeof navigator.vibrate !== "function" || document.visibilityState === "hidden"
      || !window.matchMedia("(max-width: 720px) and (pointer: coarse)").matches
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches
      || navigator.userActivation?.isActive === false || now - lastPulse < 180) return false;
  try {
    const accepted = navigator.vibrate(8);
    if (accepted) lastPulse = now;
    return accepted;
  } catch { return false; }
}

export function installMobileClickHaptics() {
  const click = (event: MouseEvent) => {
    if (!event.isTrusted || !event.detail) return;
    const target = event.target instanceof Element ? event.target.closest('button,a[href],[role="button"]') : null;
    if (!target || target.matches(':disabled,[aria-disabled="true"]')) return;
    mobileHaptic();
  };
  document.addEventListener("click", click, { capture: true, passive: true });
  return () => document.removeEventListener("click", click, true);
}
