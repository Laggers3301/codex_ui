// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useMobileComposerControls } from "./useMobileComposerControls";

it("holds mobile controls across keyboard blur, releases and cleans up without touching desktop", async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let mobile = true;
  vi.stubGlobal("matchMedia", () => ({ matches: mobile }));
  const element = document.createElement("div"), mount = document.createElement("div");
  element.innerHTML = '<div class="composerTools"><button>Model</button></div><div contenteditable="true"></div>';
  document.body.append(element, mount); const root = createRoot(mount);
  function Fixture() { useMobileComposerControls(element); return null; }
  try {
    await act(async () => root.render(<Fixture />));
    const button = element.querySelector("button")!;
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(element.dataset.mobileControlInteraction).toBe("true");
    window.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(349); expect(element.dataset.mobileControlInteraction).toBe("true");
    vi.advanceTimersByTime(1); expect(element.dataset.mobileControlInteraction).toBeUndefined();
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    window.dispatchEvent(new Event("pointercancel"));
    expect(element.dataset.mobileControlInteraction).toBeUndefined();
    mobile = false; button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(element.dataset.mobileControlInteraction).toBeUndefined();
    mobile = true; button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    vi.advanceTimersByTime(1600); expect(element.dataset.mobileControlInteraction).toBeUndefined();
    button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await act(async () => root.unmount());
    expect(element.dataset.mobileControlInteraction).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (mount.childNodes.length) await act(async () => root.unmount());
    element.remove(); mount.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
  }
});
