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
          || !event.target.closest("button")) return;
      // Keep an already expanded editor open across blur, but never expand
      // the idle capsule on pointerdown: that would move the pressed target
      // before click/pointerup (especially fragile for touch on WebKit).
      if (element.getBoundingClientRect().height <= 60
          && !element.querySelector(".composerRichInput:focus-within")) return;
      clearTimeout(timer);
      element.dataset.mobileControlInteraction = "true";
      timer = setTimeout(release, 1600); // Interrupted gestures cannot pin it forever.
    };
    const finish = () => {
      if (!element.hasAttribute("data-mobile-control-interaction")) return;
      clearTimeout(timer); timer = setTimeout(release, 350);
    };
    const keepDetails = (event: MouseEvent) => {
      if (!matchMedia("(max-width: 720px)").matches || !(event.target instanceof Element)
          || !event.target.closest(".composerThreadActivity button,.queuedSubmissionStrip button")
          || element.getBoundingClientRect().height <= 60) return;
      // Reading/toggling inline task details must not collapse them when the
      // keyboard blurs. An actual outside interaction dismisses this latch.
      element.dataset.mobileDetailOpen = "true";
    };
    const focusEditor = (event: MouseEvent) => {
      if (!matchMedia("(max-width: 720px)").matches || !(event.target instanceof Element)
          || event.target.closest("button,a,input,textarea,select,[role='button']")) return;
      const textArea = event.target.closest(".composerRichEditor");
      const capsulePadding = (event.target === element || event.target.matches(".composerBody"))
        && element.getBoundingClientRect().height <= 60;
      if (!textArea && !capsulePadding) return;
      const editor = element.querySelector<HTMLElement>(".composerRichInput[contenteditable='true']");
      // Focus in the trusted click itself, not after React, a timer or RAF:
      // WebKit's keyboard permission is tied to this user gesture. The text
      // wrapper/padding is not itself contenteditable, so a native tap there
      // previously only expanded the shell and needed another tap to type.
      if (editor && document.activeElement !== editor) editor.focus({ preventScroll: true });
    };
    const outside = (event: Event) => {
      if (event.target instanceof Node && !element.contains(event.target)) delete element.dataset.mobileDetailOpen;
    };
    element.addEventListener("pointerdown", begin, true);
    element.addEventListener("click", keepDetails, true);
    element.addEventListener("click", focusEditor);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      release(); element.removeEventListener("pointerdown", begin, true);
      delete element.dataset.mobileDetailOpen;
      element.removeEventListener("click", keepDetails, true);
      element.removeEventListener("click", focusEditor);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }, [element]);
}
