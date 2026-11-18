const flags = [
  ["sidebar-collapsed", ".threadList.collapsed", "threadList"],
  ["long-text-open", ".composerLongTextDialog[open]", "composerLongTextDialog"],
  ["file-preview", ".filePreviewScrim", "filePreviewScrim"],
  ["modal-scrim", ".modalScrim", "modalScrim"],
  ["modal-backdrop", ".modalBackdrop", "modalBackdrop"],
  ["search", ".globalSearchScrim", "globalSearchScrim"],
  ["right-open", ".workspace.diffPanelOpen", "workspace"],
  ["directory-picker", ".directoryPickerScrim", "directoryPickerScrim"],
] as const;

/** Replace whole-page relational style invalidation with explicit shell state.
 * Only relevant inserted/removed/class-switched shells cause a document query;
 * streaming text, SVG updates and animation style writes do not. */
export function observeShellPresentation(body: HTMLElement): () => void {
  // Sidebar motion plays only for a real toggle after load, announced by a short-lived
  // direction on <html>. A steady-state selector would also match the moment motion
  // is "armed" and replay the animation on an already-settled page (a visible jerk).
  const root = body.ownerDocument.documentElement;
  let armed = false, clearMotion = 0;
  const armMotion = window.setTimeout(() => { armed = true; }, 900);
  const announce = (direction: "collapse" | "expand") => {
    root.setAttribute("data-shell-motion", direction);
    window.clearTimeout(clearMotion);
    clearMotion = window.setTimeout(() => root.removeAttribute("data-shell-motion"), 480);
  };
  // The right panel snaps to its final layout and is then animated with the Web Animations API from its width:
  // it slides in or out, and the centred transcript glides across by half that width. Explicit pixel values are
  // used instead of a CSS variable on <html>, because changing an inherited variable there restyles the whole page.
  let rightWidth = 0, rightAnimations: Animation[] = [];
  // React owns the panel's inline width (0 when closed); the closing overlay borrows these properties and must
  // hand back exactly what it found, or a stale auto width would keep reserving space in the grid.
  const borrowed = ["width", "visibility", "pointer-events"] as const;
  let saved: Record<string, string> = {};
  const clearRightPanel = (panel: HTMLElement | null) => {
    if (!panel || !panel.hasAttribute("data-right-closing")) return;
    panel.removeAttribute("data-right-closing");
    // If React has already written its own width (a quick reopen), that newer value stays.
    for (const name of borrowed) if (panel.style.getPropertyPriority(name) === "important") { panel.style.removeProperty(name); if (saved[name]) panel.style.setProperty(name, saved[name]); }
    saved = {};
  };
  const announceRight = (open: boolean) => {
    const panel = body.querySelector<HTMLElement>(".diffReviewPanel"), canvas = body.querySelector<HTMLElement>(".writingCanvas");
    if (open) rightWidth = panel?.getBoundingClientRect().width ?? rightWidth;
    if (!panel || rightWidth < 80 || typeof panel.animate !== "function" || window.matchMedia("(max-width: 720px), (prefers-reduced-motion: reduce)").matches) return;
    for (const animation of rightAnimations) animation.cancel();
    clearRightPanel(panel);
    const timing = { duration: 380, easing: "cubic-bezier(.22,1,.36,1)" }, travel = Math.round(rightWidth);
    rightAnimations = [];
    if (open) {
      rightAnimations.push(panel.animate([{ transform: `translate3d(${travel}px,0,0)`, opacity: 0 }, { transform: "none", opacity: 1 }], { ...timing, fill: "backwards" }));
      if (canvas) rightAnimations.push(canvas.animate([{ transform: `translate3d(${travel / 2}px,0,0)` }, { transform: "none" }], { ...timing, fill: "backwards" }));
    } else {
      // Lift the closing panel out of the grid (the transcript is already full width) and slide it away.
      panel.setAttribute("data-right-closing", "");
      saved = Object.fromEntries(borrowed.map(name => [name, panel.style.getPropertyValue(name)]));
      panel.style.setProperty("width", `${travel}px`, "important");
      panel.style.setProperty("visibility", "visible", "important");
      panel.style.setProperty("pointer-events", "none", "important");
      const out = panel.animate([{ transform: "none", opacity: 1 }, { transform: `translate3d(${travel}px,0,0)`, opacity: 0 }], { ...timing, fill: "forwards" });
      out.finished.then(() => clearRightPanel(panel), () => {});
      rightAnimations.push(out);
      if (canvas) rightAnimations.push(canvas.animate([{ transform: `translate3d(${-travel / 2}px,0,0)` }, { transform: "none" }], { ...timing, fill: "backwards" }));
    }
  };
  const previous = new Map(flags.map(([key]) => [`data-shell-${key}`, body.getAttribute(`data-shell-${key}`)]));
  const sync = (index: number) => {
    const [key, selector] = flags[index], name = `data-shell-${key}`;
    const present = Boolean(body.querySelector(selector));
    if (body.hasAttribute(name) !== present) { body.toggleAttribute(name, present); if (armed && key === "sidebar-collapsed") announce(present ? "collapse" : "expand"); if (armed && key === "right-open") announceRight(present); }
  };
  flags.forEach((_, index) => sync(index));
  const observer = new MutationObserver(records => {
    const dirty = new Set<number>();
    for (const record of records) {
      if (record.type === "attributes") {
        const node = record.target as Element;
        const oldClasses = record.attributeName === "class" ? record.oldValue?.split(/\s+/) ?? [] : [];
        flags.forEach(([, , watch], index) => {
          if (node.classList.contains(watch) || oldClasses.includes(watch)) dirty.add(index);
        });
      } else {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (!(node instanceof Element)) continue;
          flags.forEach(([, , watch], index) => {
            if (!dirty.has(index) && (node.classList.contains(watch) || node.childElementCount && node.querySelector(`.${watch}`))) dirty.add(index);
          });
        }
      }
    }
    dirty.forEach(sync);
  });
  observer.observe(body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["class", "open"] });
  return () => {
    window.clearTimeout(armMotion); window.clearTimeout(clearMotion);
    for (const animation of rightAnimations) animation.cancel();
    clearRightPanel(body.querySelector<HTMLElement>(".diffReviewPanel"));
    root.removeAttribute("data-shell-motion");
    observer.disconnect();
    for (const [name, value] of previous) {
      if (value === null) body.removeAttribute(name);
      else body.setAttribute(name, value);
    }
  };
}
