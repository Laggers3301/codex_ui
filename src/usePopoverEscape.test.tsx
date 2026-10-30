// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePopoverEscape } from "./usePopoverEscape";

it("consumes visible-popover Escape before the global stop shortcut and cleans up", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const dismiss = vi.fn(), stop = vi.fn();
  const onWindowKey = (event: KeyboardEvent) => { if (event.key === "Escape") stop(); };
  window.addEventListener("keydown", onWindowKey);
  function Fixture({ present }: { present: boolean }) { usePopoverEscape(present, dismiss); return <button>menu</button>; }
  try {
    await act(async () => root.render(<Fixture present />));
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(dismiss).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled(); expect(escape.defaultPrevented).toBe(true);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true }));
    expect(dismiss).toHaveBeenCalledOnce();
    stop.mockClear();
    // Callers keep present=true for their exit animation, protecting this gap.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dismiss).toHaveBeenCalledTimes(2); expect(stop).not.toHaveBeenCalled();
    await act(async () => root.render(<Fixture present={false} />));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(stop).toHaveBeenCalledOnce(); expect(dismiss).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<Fixture present />));
    await act(async () => root.unmount());
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(stop).toHaveBeenCalledTimes(2);
  } finally {
    if (container.childNodes.length) await act(async () => root.unmount());
    window.removeEventListener("keydown", onWindowKey); container.remove(); vi.unstubAllGlobals();
  }
});
