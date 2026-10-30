import { useLayoutEffect } from "react";

/** Keep a touch target mounted while iOS dismisses the editor's keyboard.
 * Native iOS buttons need not take focus, so :focus-within alone is unsafe. */
export function useMobileComposerControls(element: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const release = () => { clearTimeout(timer); delete element.dataset.mobileControlInteraction; };
    const begin = (event: PointerEvent) => {
      if (!matchMedia("(max-width: 720px)").matches || !(event.target instanceof Element)
          || !event.target.closest(".composerControlRow button,.composerTools button")) return;
      clearTimeout(timer);
      element.dataset.mobileControlInteraction = "true";
      timer = setTimeout(release, 1600); // Interrupted gestures cannot pin it forever.
    };
    const finish = () => {
      if (!element.hasAttribute("data-mobile-control-interaction")) return;
      clearTimeout(timer); timer = setTimeout(release, 350);
    };
    element.addEventListener("pointerdown", begin, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      release(); element.removeEventListener("pointerdown", begin, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }, [element]);
}
