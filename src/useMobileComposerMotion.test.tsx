// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useMobileComposerMotion } from "./useMobileComposerMotion";
it("animates the real composer height once per compact transition and cleans up", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") }));
  vi.stubGlobal("CSS", { registerProperty() {} });
  let resize: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect = disconnect; });
  const element = document.createElement("div"), container = document.createElement("div"); document.body.append(container, element);
  let height = 52; element.getBoundingClientRect = () => ({ height } as DOMRect);
  const animation = { onfinish: null as null | (() => void), cancel: vi.fn() };
  const animate = vi.fn(() => animation); element.animate = animate as unknown as typeof element.animate;
  const root = createRoot(container);
  function Fixture() { useMobileComposerMotion(element); return null; }
  try {
    await act(async () => root.render(<Fixture />));
    height = 132; resize(); expect(element.dataset.mobileComposerMotion).toBe("expand");
    expect(animate.mock.calls[0]).toEqual([[{ "--mobile-composer-motion-height": "52px" }, { "--mobile-composer-motion-height": "132px" }], { duration: 260, easing: "cubic-bezier(.22,1,.36,1)" }]);
    resize(); expect(animate).toHaveBeenCalledOnce();
    animation.onfinish?.(); expect(element.dataset.mobileComposerMotion).toBeUndefined();
    height = 52; resize(); expect(element.dataset.mobileComposerMotion).toBe("collapse");
    await act(async () => root.unmount()); expect(animation.cancel).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalledOnce();
    expect(element.style.getPropertyValue("--mobile-composer-motion-height")).toBe("");
  } finally {
    if (container.childNodes.length) await act(async () => root.unmount());
    container.remove(); element.remove(); vi.unstubAllGlobals();
  }
});
