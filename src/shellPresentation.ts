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
  const previous = new Map(flags.map(([key]) => [`data-shell-${key}`, body.getAttribute(`data-shell-${key}`)]));
  const sync = (index: number) => {
    const [key, selector] = flags[index], name = `data-shell-${key}`;
    const present = Boolean(body.querySelector(selector));
    if (body.hasAttribute(name) !== present) body.toggleAttribute(name, present);
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
    observer.disconnect();
    for (const [name, value] of previous) {
      if (value === null) body.removeAttribute(name);
      else body.setAttribute(name, value);
    }
  };
}
