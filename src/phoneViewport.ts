const property = "--phone-viewport-height";
// Only elements whose rules actually consume the visual viewport length.
// In particular, ordinary transcript paragraphs never receive this input.
const consumers = "html,body,#root,.threadList,.v2AccountMenu,.rightWorkspace,.diffReviewPanel,.composer,.composerBody,.composerRichEditor,.codexApprovalRequests,.filePreviewDialog,.imagePreviewDialog,.temporaryCloseDialog,.temporaryAskPanel";
let registered: boolean | undefined;

export function observePhoneViewport(): () => void {
  const root = document.documentElement, media = matchMedia("(max-width: 900px)");
  if (registered === undefined) {
    try {
      CSS.registerProperty({ name: property, syntax: "<length>", inherits: false, initialValue: `${Math.round(innerHeight)}px` });
      registered = true;
    } catch { registered = false; }
  }
  const local = registered;
  const targets = new Set<HTMLElement>();
  let pixels: string | null = null, frame = 0, wasMobile = media.matches;
  const apply = (node: HTMLElement) => {
    // Mutating even a non-inherited custom property on HTML/BODY can still
    // invalidate the entire document's computed-style cache in Blink. Size
    // these three shell boxes through native, non-inherited geometry instead.
    if (local && (node === root || node === document.body || node.id === "root")) {
      for (const name of ["height", "max-height"]) {
        if (media.matches && pixels !== null) {
          if (node.style.getPropertyValue(name) !== pixels || node.style.getPropertyPriority(name) !== "important") node.style.setProperty(name, pixels, "important");
        } else if (node.style.getPropertyValue(name)) node.style.removeProperty(name);
      }
      return;
    }
    if (pixels === null) { if (node.style.getPropertyValue(property)) node.style.removeProperty(property); }
    else if (node.style.getPropertyValue(property) !== pixels) node.style.setProperty(property, pixels);
  };
  const discover = (node: Element) => {
    if (node instanceof HTMLElement && node.matches(consumers)) { targets.add(node); apply(node); }
    for (const child of node.querySelectorAll<HTMLElement>(consumers)) { targets.add(child); apply(child); }
  };
  const sync = () => {
    frame = 0;
    const next = media.matches ? `${Math.round(window.visualViewport?.height || innerHeight)}px` : local ? `${Math.round(innerHeight)}px` : null;
    if (next !== pixels || wasMobile !== media.matches) {
      wasMobile = media.matches;
      pixels = next;
      if (local) for (const target of targets) apply(target);
      else apply(root);
    }
    // iOS may scroll the document to reveal its caret. The app owns a fixed
    // visual-viewport shell; compensate only a real offset, never every event.
    if (media.matches && (scrollX !== 0 || scrollY !== 0)) window.scrollTo(0, 0);
  };
  if (local) discover(root);
  const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
  const observer = local ? new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") {
        const node = record.target as HTMLElement;
        if (!targets.has(node) && node.matches(consumers)) { targets.add(node); apply(node); }
      } else for (const node of record.addedNodes) if (node instanceof Element) discover(node);
    }
    for (const target of targets) if (!target.isConnected) targets.delete(target);
  }) : null;
  observer?.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  media.addEventListener("change", schedule);
  for (const name of ["resize", "orientationchange", "scroll"]) window.addEventListener(name, schedule, { passive: true });
  window.visualViewport?.addEventListener("resize", schedule, { passive: true });
  window.visualViewport?.addEventListener("scroll", schedule, { passive: true });
  sync();
  return () => {
    cancelAnimationFrame(frame); observer?.disconnect(); media.removeEventListener("change", schedule);
    for (const name of ["resize", "orientationchange", "scroll"]) window.removeEventListener(name, schedule);
    window.visualViewport?.removeEventListener("resize", schedule); window.visualViewport?.removeEventListener("scroll", schedule);
    for (const target of targets) {
      target.style.removeProperty(property);
      if (local && (target === root || target === document.body || target.id === "root")) { target.style.removeProperty("height"); target.style.removeProperty("max-height"); }
    }
    root.style.removeProperty(property);
  };
}
