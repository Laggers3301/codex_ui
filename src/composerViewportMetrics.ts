const heightProperty = "--composer-height";
const viewportProperty = "--messages-viewport-height";
const consumersSelector = ".messages, .scrollToBottomButton, .conversationTurnRow.topAnchoredTurn, .conversationLiveTail.topAnchoredTurn, .codexApprovalRequests, .threadOpeningLayer";
let localProperties: boolean | undefined;

/** These changing layout inputs must not invalidate every transcript descendant. */
function registerLocalMetrics(): boolean {
  if (localProperties !== undefined) return localProperties;
  if (typeof CSS === "undefined" || typeof CSS.registerProperty !== "function") return false;
  try {
    CSS.registerProperty({ name: heightProperty, syntax: "<length>", inherits: false, initialValue: "94px" });
    return localProperties = true;
  } catch {
    // Older engines keep the original inherited-variable behavior, not broken
    // padding or an unscrollable last turn. Never require CSS Houdini to type.
    return localProperties = false;
  }
}

export function observeComposerViewportMetrics(composer: HTMLElement, messages: HTMLElement | null, followEnd: () => void): () => void {
  const conversation = composer.parentElement;
  if (!conversation) return () => {};
  const local = registerLocalMetrics();
  const consumers = new Set<HTMLElement>();
  const originals = new Map<HTMLElement, Map<string, string>>();
  let height = 0, viewportHeight = 0;
  const write = (element: HTMLElement, name: string, value: number) => {
    const pixels = `${value}px`;
    if (element.style.getPropertyValue(name) === pixels) return;
    let saved = originals.get(element);
    if (!saved) originals.set(element, saved = new Map());
    if (!saved.has(name)) saved.set(name, element.style.getPropertyValue(name));
    element.style.setProperty(name, pixels);
  };
  const restore = (element: HTMLElement) => {
    for (const [name, value] of originals.get(element) ?? []) {
      if (value) element.style.setProperty(name, value);
      else element.style.removeProperty(name);
    }
    originals.delete(element);
  };
  const sync = (element: HTMLElement) => {
    if (height > 0) write(element, heightProperty, height);
    if (viewportHeight > 0 && element.matches(".topAnchoredTurn")) write(element, viewportProperty, viewportHeight);
  };
  const discover = (node: Element) => {
    if (node instanceof HTMLElement && node.matches(consumersSelector)) { consumers.add(node); sync(node); }
    for (const element of node.querySelectorAll<HTMLElement>(consumersSelector)) { consumers.add(element); sync(element); }
  };
  if (local) discover(conversation);
  else consumers.add(conversation);
  const updateHeight = (entries?: ResizeObserverEntry[]) => {
    if (!composer.isConnected || composer.parentElement !== conversation) return;
    const box = entries?.[0]?.borderBoxSize?.[0];
    const next = box?.blockSize ?? composer.getBoundingClientRect().height;
    // Ignore subpixel noise BEFORE publishing any style changes.
    if (next <= 0 || Math.abs(next - height) < .5) return;
    height = next;
    for (const element of consumers) if (conversation.contains(element) || element === conversation) sync(element);
    followEnd();
  };
  const updateViewport = () => {
    if (!messages?.isConnected || !conversation.contains(messages)) return;
    const next = messages.clientHeight;
    if (next <= 0 || next === viewportHeight) return;
    viewportHeight = next;
    if (local) {
      for (const element of consumers) if (element.matches(".topAnchoredTurn")) sync(element);
    } else write(conversation, viewportProperty, next);
  };
  // Newly loaded turns/approval cards get the current values once. Character
  // data and style mutations (including our own writes) never trigger a scan.
  const mutations = local ? new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") {
        const node = record.target as HTMLElement;
        if (node.matches(consumersSelector)) { consumers.add(node); sync(node); }
        else if (consumers.delete(node)) restore(node);
      } else {
        for (const node of record.addedNodes) if (node instanceof Element) discover(node);
      }
    }
    for (const node of consumers) if (!conversation.contains(node)) { consumers.delete(node); restore(node); }
  }) : null;
  mutations?.observe(conversation, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  const observer = new ResizeObserver(updateHeight);
  observer.observe(composer, { box: "border-box" });
  const viewportObserver = messages ? new ResizeObserver(updateViewport) : null;
  if (messages) viewportObserver?.observe(messages);
  updateHeight(); updateViewport();
  return () => {
    observer.disconnect(); viewportObserver?.disconnect(); mutations?.disconnect();
    for (const node of originals.keys()) restore(node);
  };
}
