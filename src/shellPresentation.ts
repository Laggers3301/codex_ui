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
  const previous = new Map(flags.map(([key]) => [`data-shell-${key}`, body.getAttribute(`data-shell-${key}`)]));
  const sync = (index: number) => {
    const [key, selector] = flags[index], name = `data-shell-${key}`;
    const present = Boolean(body.querySelector(selector));
    if (body.hasAttribute(name) !== present) { body.toggleAttribute(name, present); if (armed && key === "sidebar-collapsed") announce(present ? "collapse" : "expand"); }
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
    window.clearTimeout(armMotion); window.clearTimeout(clearMotion); root.removeAttribute("data-shell-motion");
    observer.disconnect();
    for (const [name, value] of previous) {
      if (value === null) body.removeAttribute(name);
      else body.setAttribute(name, value);
    }
  };
}
