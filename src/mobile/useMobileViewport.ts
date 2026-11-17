import { useLayoutEffect } from "react";

const editable = 'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]),textarea,select,[contenteditable="true"]';

/** Geometry belongs to the phone shell, never to every transcript descendant.
 * The document itself must never stay scrolled: iOS may scroll it to reveal a
 * caret or during a rubber-band pull, which left the fixed shell displaced. */
export function useMobileViewport(shell: HTMLElement | null, enabled: boolean) {
  useLayoutEffect(() => {
    if (!shell || !enabled) return;
    let frame = 0;
    const timers = new Set<number>();
    const sync = () => {
      frame = 0;
      const viewport = window.visualViewport;
      if (scrollX !== 0 || scrollY !== 0) window.scrollTo(0, 0);
      const layoutHeight = innerHeight, height = Math.round(viewport?.height ?? layoutHeight);
      const keyboard = document.activeElement instanceof Element && document.activeElement.matches(editable) && layoutHeight - height > 80;
      // Follow a panned visual viewport only while a keyboard is actually up;
      // otherwise a stale/overscrolled offset must not move the whole shell.
      const top = keyboard ? Math.max(0, Math.min(Math.round(viewport?.offsetTop ?? 0), layoutHeight - height)) : 0;
      for (const [key, value] of [["--mobile-ui-height", `${height}px`], ["--mobile-ui-top", `${top}px`]]) {
        if (shell.style.getPropertyValue(key) !== value) shell.style.setProperty(key, value);
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    // Keyboard show/hide animations do not always end with a viewport event.
    const settle = () => { schedule(); for (const delay of [120, 360, 700]) { const id = window.setTimeout(() => { timers.delete(id); schedule(); }, delay); timers.add(id); } };
    sync();
    window.visualViewport?.addEventListener("resize", schedule); window.visualViewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule); window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("focusin", settle); window.addEventListener("focusout", settle); window.addEventListener("pageshow", settle);
    return () => {
      cancelAnimationFrame(frame); for (const id of timers) window.clearTimeout(id);
      window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule);
      window.removeEventListener("focusin", settle); window.removeEventListener("focusout", settle); window.removeEventListener("pageshow", settle);
      shell.style.removeProperty("--mobile-ui-height"); shell.style.removeProperty("--mobile-ui-top");
    };
  }, [shell, enabled]);
}
