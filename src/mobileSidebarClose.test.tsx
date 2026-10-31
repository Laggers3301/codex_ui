// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileSidebar } from "./useMobileSidebar";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("retains the closing pose until the closed state commits, even with delayed rendering", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") }));
  vi.useFakeTimers();
  const change = vi.fn();
  let setOpen!: (open: boolean) => void;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  function Fixture({ collapsed }: { collapsed: boolean }) {
    setOpen = useMobileSidebar(collapsed, change);
    return <section className="threadColumn" />;
  }
  try {
    await act(async () => root.render(<Fixture collapsed={false} />));
    act(() => setOpen(false));
    const offset = document.documentElement.style.getPropertyValue("--mobile-sidebar-offset");
    expect(parseFloat(offset)).toBeLessThan(0);
    await act(async () => { vi.advanceTimersByTime(280); });
    expect(change).toHaveBeenCalledExactlyOnceWith(true);
    expect(document.documentElement.style.getPropertyValue("--mobile-sidebar-offset")).toBe(offset);
    expect(document.documentElement.style.getPropertyValue("--mobile-sidebar-progress")).toBe("0");
    await act(async () => root.render(<Fixture collapsed={true} />));
    expect(document.documentElement.style.getPropertyValue("--mobile-sidebar-offset")).toBe("");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("cancels the old closing commit when the user reopens immediately", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") }));
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.useFakeTimers();
  const change = vi.fn();
  let setOpen!: (open: boolean) => void;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  function Fixture() { setOpen = useMobileSidebar(false, change); return <section className="threadColumn" />; }
  try {
    await act(async () => root.render(<Fixture />));
    act(() => { setOpen(false); setOpen(true); });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
