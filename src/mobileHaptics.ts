/** Touch haptics for the web UI.
 *
 * Android and other browsers with the Vibration API get short patterns. iOS Safari has no Vibration API,
 * but since Safari 17.4/18 a user-initiated toggle of a native `switch` plays the system haptic, so a
 * detached, unrendered switch is clicked instead (focus and the keyboard are untouched). Both paths only
 * run inside a user gesture, on coarse-pointer devices, never in reduced-motion mode, and can be turned
 * off with {@link setHapticsEnabled}. Desktop mice never vibrate. */
export type HapticKind = "tap" | "select" | "snap" | "success";

/** tap: an ordinary press. select: a toggle or tab. snap: something clicked into place (drawer, send, capsule). success: done (copy). */
const PATTERNS: Record<HapticKind, number | number[]> = { tap: 8, select: 5, snap: 12, success: [8, 55, 12] };
const MIN_GAP_MS = 120;
const STORAGE_KEY = "codex-web-haptics";
let lastPulse = -Infinity;

export function hapticsEnabled(): boolean {
  try { return window.localStorage.getItem(STORAGE_KEY) !== "off"; } catch { return true; }
}
export function setHapticsEnabled(enabled: boolean) {
  try { if (enabled) window.localStorage.removeItem(STORAGE_KEY); else window.localStorage.setItem(STORAGE_KEY, "off"); } catch { /* Preference is best effort. */ }
}

function switchTick(): boolean {
  const label = document.createElement("label"), input = document.createElement("input");
  label.setAttribute("aria-hidden", "true"); label.style.display = "none";
  input.type = "checkbox"; input.setAttribute("switch", ""); input.tabIndex = -1;
  label.append(input); document.head.append(label);
  label.click(); label.remove();
  return true;
}

/** One haptic pulse (or pattern). Returns whether something was played. Never throws. */
export function haptic(kind: HapticKind = "tap", now = performance.now()): boolean {
  try {
    if (document.visibilityState === "hidden" || now - lastPulse < MIN_GAP_MS || !hapticsEnabled()
        || !window.matchMedia("(pointer: coarse)").matches
        || window.matchMedia("(prefers-reduced-motion: reduce)").matches
        || navigator.userActivation?.isActive === false) return false;
    const pattern = PATTERNS[kind];
    if (typeof navigator.vibrate === "function") {
      const accepted = navigator.vibrate(pattern);
      if (accepted) lastPulse = now;
      return accepted;
    }
    if (!switchTick()) return false;
    lastPulse = now;
    // The switch plays one tick per toggle; a pattern is a second tick after its gap.
    if (Array.isArray(pattern)) window.setTimeout(() => { try { switchTick(); } catch { /* Decoration only. */ } }, pattern[0] + pattern[1]);
    return true;
  } catch { return false; }
}

/** A plain press (kept for existing callers). */
export function mobileHaptic(now = performance.now()): boolean { return haptic("tap", now); }

/** One firm tick for a deliberate shape change (composer capsule <-> box). */
export function mobileShapeHaptic(now = performance.now()): boolean { return haptic("snap", now); }

const CONTROL = 'button,a[href],[role="button"],[role="menuitem"],[role="tab"],[role="switch"],[role="radio"],[role="checkbox"],[role="option"],[role="menuitemradio"],[role="menuitemcheckbox"],summary,select,input[type="checkbox"],input[type="radio"]';
const SELECTION = '[role="tab"],[role="switch"],[role="radio"],[role="checkbox"],[role="option"],[role="menuitemradio"],[role="menuitemcheckbox"],[aria-pressed],select,input[type="checkbox"],input[type="radio"]';
const CONFIRMING = ".mobileUiSendButton,.sendButton";
const COPYING = '[aria-label*="复制"],[title*="复制"],[aria-label*="Copy"],[aria-label*="copy"]';

/** Which haptic a press on `target` deserves, or null for none. Opt out with data-haptic="off". */
export function hapticKindFor(target: Element | null): HapticKind | null {
  const control = target?.closest(CONTROL);
  if (!control || control.matches(':disabled,[aria-disabled="true"]') || control.closest('[data-haptic="off"]')) return null;
  // Links inside rendered message text are reading, not interface chrome.
  if (control.matches("a[href]") && control.closest(".messageMarkdown,.markdown")) return null;
  if (control.matches(CONFIRMING)) return "snap";
  if (control.matches(COPYING)) return "success";
  if (control.matches(SELECTION)) return "select";
  return "tap";
}

export function installMobileClickHaptics() {
  const click = (event: MouseEvent) => {
    if (!event.isTrusted || !event.detail) return;
    const kind = hapticKindFor(event.target instanceof Element ? event.target : null);
    if (kind) haptic(kind);
  };
  document.addEventListener("click", click, { capture: true, passive: true });
  return () => document.removeEventListener("click", click, true);
}
