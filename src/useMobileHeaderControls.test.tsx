// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useMobileHeaderControls } from "./useMobileHeaderControls";

it("reveals for five seconds, extends interaction and resets safely on conversation change", async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let state: ReturnType<typeof useMobileHeaderControls>;
  function Fixture({ scope }: { scope: string }) { state = useMobileHeaderControls(scope); return <div ref={state.controls} data-open={state.revealed} />; }
  try {
    await act(async () => root.render(<Fixture scope="a" />)); expect(state!.revealed).toBe(false);
    await act(async () => state!.reveal()); expect(state!.revealed).toBe(true);
    await act(async () => vi.advanceTimersByTime(4900)); expect(state!.revealed).toBe(true);
    await act(async () => state!.arm());
    await act(async () => vi.advanceTimersByTime(4900)); expect(state!.revealed).toBe(true);
    await act(async () => vi.advanceTimersByTime(100)); expect(state!.revealed).toBe(false);
    await act(async () => state!.reveal());
    const menu = document.createElement("button"); menu.setAttribute("aria-expanded", "true"); state!.controls.current!.append(menu);
    await act(async () => vi.advanceTimersByTime(5000)); expect(state!.revealed).toBe(true);
    menu.remove(); await act(async () => vi.advanceTimersByTime(5000)); expect(state!.revealed).toBe(false);
    await act(async () => state!.reveal()); await act(async () => root.render(<Fixture scope="b" />)); expect(state!.revealed).toBe(false);
    await act(async () => root.unmount()); expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (container.childNodes.length) await act(async () => root.unmount());
    container.remove(); vi.unstubAllGlobals(); vi.useRealTimers();
  }
});
