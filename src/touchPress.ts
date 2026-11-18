/** Touch timing shared by the conversation list and the drawer swipe, taken from native conventions:
 *  - press feedback waits ~100ms (Android tap timeout, iOS delaysContentTouches) so a swipe or scroll never flashes a pressed row;
 *  - a finger that moves past the touch slop (8px) is a swipe or scroll, never a tap and never a long press;
 *  - a long press needs a still finger for ~450ms (iOS reorder 500ms, Android 400-500ms). Mice keep the quick 180ms hold. */
export const TOUCH_PRESS_DELAY_MS = 110;
export const TOUCH_LONG_PRESS_MS = 450;
export const MOUSE_LONG_PRESS_MS = 180;
export const TOUCH_SLOP_PX = 8;
export const SIDEBAR_SWIPE_EVENT = "codex-sidebar-swipe";

export const longPressDelay = (pointerType: string) => pointerType === "mouse" ? MOUSE_LONG_PRESS_MS : TOUCH_LONG_PRESS_MS;

const PRESSABLE = ".threadRow,.v2WorkspaceFolderButton";

/** Marks the pressed row with data-pressed only once a touch has stayed put; any movement or a drawer swipe withdraws it. */
export function installDeferredTouchPress(): () => void {
  let timer = 0, row: Element | null = null, x = 0, y = 0, pointerId = -1;
  const clear = () => { window.clearTimeout(timer); row?.removeAttribute("data-pressed"); row = null; pointerId = -1; };
  const down = (event: PointerEvent) => {
    clear();
    if (event.pointerType === "mouse" || !(event.target instanceof Element)) return;
    const target = event.target.closest(PRESSABLE);
    if (!target) return;
    x = event.clientX; y = event.clientY; pointerId = event.pointerId; row = target;
    timer = window.setTimeout(() => row?.setAttribute("data-pressed", ""), TOUCH_PRESS_DELAY_MS);
  };
  const move = (event: PointerEvent) => {
    if (row && event.pointerId === pointerId && Math.hypot(event.clientX - x, event.clientY - y) > TOUCH_SLOP_PX) clear();
  };
  const options = { capture: true, passive: true } as const;
  document.addEventListener("pointerdown", down, options);
  document.addEventListener("pointermove", move, options);
  document.addEventListener("pointerup", clear, options);
  document.addEventListener("pointercancel", clear, options);
  window.addEventListener(SIDEBAR_SWIPE_EVENT, clear);
  return () => {
    clear();
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", clear, true);
    document.removeEventListener("pointercancel", clear, true);
    window.removeEventListener(SIDEBAR_SWIPE_EVENT, clear);
  };
}
