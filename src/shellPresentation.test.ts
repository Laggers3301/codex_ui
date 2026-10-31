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
