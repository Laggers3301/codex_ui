import { useLayoutEffect } from "react";

/** Animate the actual surface, so its blur/refraction follows every frame. */
export function useMobileComposerMotion(element: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!element) return;
    let previous = { height: element.getBoundingClientRect().height, compact: element.getBoundingClientRect().height <= 60 };
    let animation: Animation | null = null;
    const restore = () => {
      delete element.dataset.mobileComposerMotion;
      element.style.removeProperty("--mobile-composer-motion-height");
    };
    const observer = new ResizeObserver(() => {
      if (animation) return;
      const height = element.getBoundingClientRect().height, compact = height <= 60;
      const before = previous; previous = { height, compact };
      if (compact && !before.compact && matchMedia("(max-width: 720px)").matches) {
        // A draft can now fold too. Do not leave its scrolled editing viewport
        // halfway through a line in the one-line capsule preview.
        const editor = element.querySelector<HTMLElement>(".composerRichEditor");
        if (editor) editor.scrollTop = 0;
      }
      if (compact === before.compact || before.height < 1 || Math.abs(height - before.height) < 2
          || !matchMedia("(max-width: 720px)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches
          || typeof CSS === "undefined" || typeof CSS.registerProperty !== "function") return;
      element.dataset.mobileComposerMotion = compact ? "collapse" : "expand";
      element.style.setProperty("--mobile-composer-motion-height", `${before.height}px`);
      animation = element.animate([
        { "--mobile-composer-motion-height": `${before.height}px` },
        { "--mobile-composer-motion-height": `${height}px` }
      ], { duration: 260, easing: "cubic-bezier(.22,1,.36,1)" });
      animation.onfinish = () => { animation = null; restore(); };
    });
    observer.observe(element);
    return () => { observer.disconnect(); animation?.cancel(); restore(); };
  }, [element]);
}
