// Overlay stack for the phone shell: Escape closes the top layer everywhere.
//
// Android/other browsers also get one history fence so the system Back button
// closes the top layer instead of leaving the conversation. iOS gets NONE: any
// extra history entry (a fence, or the "forward" entry left by history.back())
// turns the screen edges into Safari's back/forward page-swipe, which then
// fights the left/right drawer drags (the page and both drawers slide together,
// or a right-edge swipe shows a snapshot page). Without entries, iOS has no
// edge navigation gesture and both edges belong to the drawers.
//
// Where the fence is used, closing from the UI never calls history.back(): the
// entry is parked (replaceState) and reused by the next layer.
type Layer = { id: symbol; close: () => void };
export function createMobileLayers(host: Window) {
  const layers: Layer[] = [];
  const key = `mobile-layer-${Math.random().toString(36).slice(2)}`;
  let listening = false;
  const nav = host.navigator;
  const ios = !!nav && (/iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1));
  const own = () => host.history.state?.mobileUiLayer === key ? host.history.state : null;
  const activate = () => {
    if (ios || !layers.length) return;
    const state = own();
    if (state?.active) return;
    if (state) host.history.replaceState({ ...state, active: true }, "", host.location.href);
    else host.history.pushState({ ...host.history.state, mobileUiLayer: key, active: true }, "", host.location.href);
  };
  const park = () => {
    const state = own();
    if (state?.active) host.history.replaceState({ ...state, active: false }, "", host.location.href);
  };
  const back = () => {
    // Landing on our own (parked) entry is a forward/replay, not a Back press.
    if (own()) return;
    layers.at(-1)?.close();
    // onClose is synchronous; React cleanup can occur after this handler.
    // Remaining layers get a fresh fence from the remove callback below.
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || !layers.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    layers.at(-1)?.close();
  };
  return {
    register(close: () => void) {
      if (!listening) { host.addEventListener("popstate", back); host.addEventListener("keydown", escape, true); listening = true; }
      const layer = { id: Symbol(), close }; layers.push(layer); activate();
      return () => {
        const index = layers.indexOf(layer); if (index !== -1) layers.splice(index, 1);
        if (layers.length) activate(); else park();
      };
    },
    closeTop() { layers.at(-1)?.close(); },
    dispose() {
      listening = false; host.removeEventListener("popstate", back); host.removeEventListener("keydown", escape, true);
      layers.splice(0); park();
    },
  };
}
