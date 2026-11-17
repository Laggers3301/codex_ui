// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LazyPane, lazyNamed } from "./lazyPanel";

function Hello({ name }: { name: string }) { return <p>hello {name}</p>; }

it("shows a placeholder until the chunk resolves, keeps one import, and renders the named export", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let release!: () => void;
  const load = vi.fn(() => new Promise<{ Hello: typeof Hello }>(resolve => { release = () => resolve({ Hello }); }));
  const Lazy = lazyNamed(load, "Hello");
  Lazy.preload(); Lazy.preload();
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<LazyPane label="测试面板"><Lazy name="panel" /></LazyPane>));
    expect(node.querySelector('[role="status"][aria-busy="true"]')?.getAttribute("aria-label")).toBe("正在加载测试面板");
    await act(async () => { release(); });
    expect(node.textContent).toBe("hello panel");
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals();
  }
});

it("lets a later preload retry after a failed chunk load", async () => {
  const load = vi.fn<() => Promise<{ Hello: typeof Hello }>>()
    .mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ Hello });
  const Lazy = lazyNamed(load, "Hello");
  Lazy.preload();
  await Promise.resolve(); await Promise.resolve();
  Lazy.preload();
  await Promise.resolve(); await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(2);
});

it("mounts synchronously once loaded and never remounts an open panel", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let mounts = 0;
  function Counter({ label }: { label: string }) {
    const [n] = React.useState(() => ++mounts);
    return <p>{label}:{n}</p>;
  }
  const Lazy = lazyNamed(() => Promise.resolve({ Counter }), "Counter");
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<LazyPane label="计数"><Lazy label="a" /></LazyPane>));
    expect(node.textContent).toBe("a:1");
    // Loaded now: a rerender of the same instance keeps its state, a fresh mount shows content in the first commit.
    await act(async () => root.render(<LazyPane label="计数"><Lazy label="b" /></LazyPane>));
    expect(node.textContent).toBe("b:1");
    await act(async () => root.render(<LazyPane label="计数"><Lazy key="fresh" label="c" /></LazyPane>));
    expect(node.textContent).toBe("c:2");
    expect(node.querySelector(".lazyPaneFallback")).toBeNull();
  } finally {
    await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals();
  }
});
