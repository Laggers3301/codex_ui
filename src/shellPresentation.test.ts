// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { observeShellPresentation } from "./shellPresentation";
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
it("tracks shell-only transitions and portalled modals without rewriting unchanged flags", async () => {
  const sidebar = document.createElement("nav"); sidebar.className = "threadList collapsed"; document.body.append(sidebar);
  const stop = observeShellPresentation(document.body), toggle = vi.spyOn(document.body, "toggleAttribute");
  expect(document.body.hasAttribute("data-shell-sidebar-collapsed")).toBe(true);
  sidebar.classList.remove("collapsed"); await Promise.resolve();
  expect(document.body.hasAttribute("data-shell-sidebar-collapsed")).toBe(false);
  const modal = document.createElement("section"); modal.innerHTML = '<div class="modalScrim"></div>'; document.body.append(modal);
  await Promise.resolve(); expect(document.body.hasAttribute("data-shell-modal-scrim")).toBe(true);
  const calls = toggle.mock.calls.length;
  const text = document.createElement("p"); text.textContent = "stream"; document.body.append(text); text.classList.add("toolExpanded");
  await Promise.resolve(); expect(toggle.mock.calls.length).toBe(calls);
  modal.remove(); await Promise.resolve(); expect(document.body.hasAttribute("data-shell-modal-scrim")).toBe(false);
  stop(); expect(document.body.hasAttribute("data-shell-sidebar-collapsed")).toBe(false);
});
it("handles open attributes, removed classes, and cleanup of existing body state", async () => {
  document.body.setAttribute("data-shell-search", "previous");
  const stop = observeShellPresentation(document.body), dialog = document.createElement("dialog"); dialog.className = "composerLongTextDialog";
  document.body.append(dialog); dialog.open = true; await Promise.resolve();
  expect(document.body.hasAttribute("data-shell-long-text-open")).toBe(true);
  dialog.open = false; await Promise.resolve(); expect(document.body.hasAttribute("data-shell-long-text-open")).toBe(false);
  const modal = document.createElement("div"); modal.className = "globalSearchScrim"; document.body.append(modal);
  await Promise.resolve(); expect(document.body.hasAttribute("data-shell-search")).toBe(true);
  modal.className = "other"; await Promise.resolve(); expect(document.body.hasAttribute("data-shell-search")).toBe(false);
  stop(); expect(document.body.getAttribute("data-shell-search")).toBe("previous"); document.body.removeAttribute("data-shell-search");
});
it("announces sidebar motion only for a real toggle after load, and never replays it on a settled page", async () => {
  vi.useFakeTimers();
  try {
    const sidebar = document.createElement("nav"); sidebar.className = "threadList"; document.body.append(sidebar);
    const stop = observeShellPresentation(document.body), root = document.documentElement;
    // Load-time toggles and the end of the arming delay are silent.
    sidebar.classList.add("collapsed"); await Promise.resolve();
    expect(root.hasAttribute("data-shell-motion")).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(root.hasAttribute("data-shell-motion")).toBe(false);
    sidebar.classList.remove("collapsed"); await Promise.resolve();
    expect(root.getAttribute("data-shell-motion")).toBe("expand");
    await vi.advanceTimersByTimeAsync(500);
    expect(root.hasAttribute("data-shell-motion")).toBe(false);
    sidebar.classList.add("collapsed"); await Promise.resolve();
    expect(root.getAttribute("data-shell-motion")).toBe("collapse");
    stop(); expect(root.hasAttribute("data-shell-motion")).toBe(false);
  } finally { vi.useRealTimers(); }
});
it("slides the right panel on a real toggle and hands its borrowed inline styles back after closing", async () => {
  vi.useFakeTimers();
  const matchMedia = vi.fn(() => ({ matches: false })); vi.stubGlobal("matchMedia", matchMedia);
  const animations: { keyframes: unknown; options: Record<string, unknown>; cancel: () => void; finished: Promise<void>; finish: () => void }[] = [];
  Element.prototype.animate = function (keyframes: unknown, options: Record<string, unknown>) {
    let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve; });
    const animation = { keyframes, options, cancel: vi.fn(), finished, finish }; animations.push(animation); return animation as unknown as Animation;
  };
  try {
    const workspace = document.createElement("div"); workspace.className = "workspace";
    const canvas = document.createElement("div"); canvas.className = "writingCanvas";
    const panel = document.createElement("aside"); panel.className = "rightWorkspace diffReviewPanel"; panel.style.width = "0px";
    workspace.append(canvas, panel); document.body.append(workspace);
    const stop = observeShellPresentation(document.body);
    await vi.advanceTimersByTimeAsync(1000);
    // Open: width is final, panel and transcript animate; nothing is borrowed.
    panel.style.width = "560px"; panel.getBoundingClientRect = () => ({ width: 560 } as DOMRect);
    workspace.classList.add("diffPanelOpen"); await Promise.resolve();
    expect(animations).toHaveLength(2);
    expect(panel.hasAttribute("data-right-closing")).toBe(false);
    // Close: React has already set width 0; the overlay borrows it, animates, then restores exactly that.
    animations.length = 0; panel.style.width = "0px";
    workspace.classList.remove("diffPanelOpen"); await Promise.resolve();
    expect(panel.hasAttribute("data-right-closing")).toBe(true);
    expect(panel.style.getPropertyValue("width")).toBe("560px"); expect(panel.style.getPropertyPriority("width")).toBe("important");
    animations[0].finish(); await Promise.resolve(); await Promise.resolve();
    expect(panel.hasAttribute("data-right-closing")).toBe(false);
    expect(panel.style.width).toBe("0px"); expect(panel.style.getPropertyPriority("width")).toBe("");
    // A quick reopen while the overlay is still out keeps React's newer width.
    workspace.classList.add("diffPanelOpen"); await Promise.resolve(); workspace.classList.remove("diffPanelOpen"); await Promise.resolve();
    expect(panel.hasAttribute("data-right-closing")).toBe(true);
    panel.style.setProperty("width", "480px"); workspace.classList.add("diffPanelOpen"); await Promise.resolve();
    expect(panel.hasAttribute("data-right-closing")).toBe(false); expect(panel.style.width).toBe("480px");
    stop();
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); delete (Element.prototype as { animate?: unknown }).animate; }
});
