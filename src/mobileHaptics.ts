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

/** One light tick for a deliberate shape change (composer capsule <-> box).
 * iOS Safari has no Vibration API; since Safari 18 a user-initiated toggle of
 * a native switch plays the system haptic. The switch is detached, unrendered
 * and never focused, so the keyboard and the caret stay where they are. */
export function mobileShapeHaptic(now = performance.now()): boolean {
  if (typeof navigator.vibrate === "function") return mobileHaptic(now);
  if (document.visibilityState === "hidden" || now - lastPulse < 180
      || !window.matchMedia("(max-width: 720px) and (pointer: coarse)").matches
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  try {
    const label = document.createElement("label"), input = document.createElement("input");
    label.setAttribute("aria-hidden", "true"); label.style.display = "none";
    input.type = "checkbox"; input.setAttribute("switch", ""); input.tabIndex = -1;
    label.append(input); document.head.append(label);
    label.click(); label.remove();
    lastPulse = now;
    return true;
  } catch { return false; }
}
