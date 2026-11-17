// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useMobileSidebar } from "./useMobileSidebar";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function Drawer({ collapsed }: { collapsed: boolean }) {
  return <><button className={`mobileSidebarBackdrop${collapsed ? " inactive" : ""}`} /><nav id="conversation-sidebar" className={`threadList${collapsed ? " collapsed" : ""}`} /></>;
}

it("moves only the drawer element, keeps the closing pose until the closed state commits, and never writes :root", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") }));
  vi.useFakeTimers();
  const change = vi.fn();
  let setOpen!: (open: boolean) => void;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  function Fixture({ collapsed }: { collapsed: boolean }) {
    setOpen = useMobileSidebar(collapsed, change);
    return <section className="threadColumn"><Drawer collapsed={collapsed} /></section>;
  }
  try {
    await act(async () => root.render(<Fixture collapsed={false} />));
    const panel = container.querySelector<HTMLElement>("#conversation-sidebar")!, scrim = container.querySelector<HTMLElement>(".mobileSidebarBackdrop")!;
    act(() => setOpen(false));
    expect(parseFloat(panel.style.transform.replace("translate3d(", ""))).toBeLessThan(0);
    expect(panel.hasAttribute("data-moving")).toBe(true); expect(scrim.style.opacity).toBe("0");
    expect(document.documentElement.getAttribute("style") ?? "").not.toContain("--mobile");
    expect(change).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(change).toHaveBeenCalledExactlyOnceWith(true);
    // Hidden by the class at once, so a delayed render can never expose the open drawer.
    expect(panel.classList.contains("collapsed")).toBe(true);
    await act(async () => root.render(<Fixture collapsed={true} />));
    expect(panel.style.transform).toBe(""); expect(panel.hasAttribute("data-moving")).toBe(false);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("shows the drawer before React renders, then commits the open state once the motion ends", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") }));
  vi.useFakeTimers();
  const change = vi.fn();
  let setOpen!: (open: boolean) => void;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  function Fixture() { setOpen = useMobileSidebar(true, change); return <section className="threadColumn"><Drawer collapsed={true} /></section>; }
  try {
    await act(async () => root.render(<Fixture />));
    const panel = container.querySelector<HTMLElement>("#conversation-sidebar")!, scrim = container.querySelector<HTMLElement>(".mobileSidebarBackdrop")!;
    act(() => setOpen(true));
    expect(panel.classList.contains("collapsed")).toBe(false); expect(scrim.classList.contains("inactive")).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe("translate3d(-380px,0,0)");
    await act(async () => { vi.advanceTimersByTime(20); });
    expect(panel.style.transform).toBe("translate3d(0px,0,0)");
    await act(async () => { vi.advanceTimersByTime(320); });
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
    expect(panel.hasAttribute("data-moving")).toBe(false); expect(panel.style.transform).toBe("");
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
