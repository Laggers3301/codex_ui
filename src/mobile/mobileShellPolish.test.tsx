// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileViewport } from "./useMobileViewport";
import { MobileHeader } from "./MobileHeader";

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

function viewport(height: number, offsetTop: number) {
  const target = new EventTarget() as EventTarget & { height: number; offsetTop: number };
  target.height = height; target.offsetTop = offsetTop;
  vi.stubGlobal("visualViewport", target);
  return target;
}

it("never leaves the phone shell displaced after the document scrolls or a keyboard closes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  const scrollTo = vi.fn(); vi.stubGlobal("scrollTo", scrollTo); vi.stubGlobal("scrollY", 310);
  const shell = document.createElement("div"), input = document.createElement("textarea");
  document.body.append(shell, input);
  const vv = viewport(844, 310);
  function Fixture() { useMobileViewport(shell, true); return null; }
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(<Fixture />));
  // No keyboard: a stale/overscrolled offset must not move the shell.
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
  expect(shell.style.getPropertyValue("--mobile-ui-top")).toBe("0px");
  // Keyboard up: follow the panned visual viewport, clamped to the layout one.
  vi.stubGlobal("scrollY", 0); input.focus(); vv.height = 500; vv.offsetTop = 900;
  vv.dispatchEvent(new Event("resize"));
  expect(shell.style.getPropertyValue("--mobile-ui-top")).toBe("344px");
  expect(shell.style.getPropertyValue("--mobile-ui-height")).toBe("500px");
  // Keyboard closed without a final viewport event still settles back to 0.
  input.blur(); vv.height = 844;
  window.dispatchEvent(new Event("focusout"));
  expect(shell.style.getPropertyValue("--mobile-ui-top")).toBe("0px");
  await act(async () => root.unmount());
  expect(shell.style.getPropertyValue("--mobile-ui-top")).toBe("");
});

it("reveals the compact control row from the title, and closes it on an outside tap", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const closed = vi.fn(), host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = (openRequest = 0) => root.render(<MobileHeader title="codex迭代" scope="u:t" sidebarOpen={false} workspaceOpen={false}
    onSidebar={() => {}} onWorkspace={() => {}} openRequest={openRequest} onOptionsClose={closed}
    controls={<div className="controls"><button type="button">sample-user 2%</button></div>} />);
  await act(async () => render());
  const title = host.querySelector<HTMLButtonElement>(".mobileUiTitle")!, row = host.querySelector<HTMLElement>(".mobileUiHeaderOptions")!;
  expect(document.querySelector("dialog")).toBeNull();
  expect(row.hasAttribute("data-open")).toBe(false); expect(row.hasAttribute("inert")).toBe(true);
  closed.mockClear();
  await act(async () => title.click());
  expect(row.hasAttribute("data-open")).toBe(true); expect(title.getAttribute("aria-expanded")).toBe("true");
  // Taps inside the row keep it open; elsewhere close it and reset the popover.
  await act(async () => row.querySelector("button")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(row.hasAttribute("data-open")).toBe(true);
  await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(row.hasAttribute("data-open")).toBe(false); expect(closed).toHaveBeenCalledOnce();
  // The "+" menu's usage entry opens the same row.
  await act(async () => render(1));
  expect(row.hasAttribute("data-open")).toBe(true);
  await act(async () => root.unmount());
});
