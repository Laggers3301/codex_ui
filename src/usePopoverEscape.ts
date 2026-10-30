import { useEffect, useRef } from "react";

/** A visible popover owns Escape, including its exit-animation interval. */
export function usePopoverEscape(present: boolean, dismiss: () => void) {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!present) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current();
    };
    // Capture before the transcript's window-level stop-turn shortcut.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [present]);
}
