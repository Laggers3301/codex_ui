// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, it, vi } from "vitest";
import { MobileComposerSettings } from "./MobileComposerSettings";

// jsdom does not implement the dialog top-layer APIs; browser QA covers them.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});

it("leaves desktop controls unwrapped and unchanged", () => {
  const child = <button className="existing">模型</button>;
  expect(renderToStaticMarkup(<MobileComposerSettings mobile={false} scope="thread" label="Astra" model={child} />)).toBe(renderToStaticMarkup(child));
});

it("aggregates controls, preserves callbacks, closes safely and resets on thread switches", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const handler = vi.fn();
  const render = (scope: string) => root.render(<MobileComposerSettings mobile scope={scope} label="Astra · High"
    context={<button className="v2ContextStatusButton" onClick={handler}>上下文</button>}
    model={<select aria-label="模型"><option>Astra</option></select>}
    speed={<select aria-label="速度"><option>标准</option></select>} />);
  try {
    await act(() => render("first"));
    expect(node.querySelectorAll("button").length).toBe(1);
    const trigger = node.querySelector("button")!;
    await act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const panel = document.querySelector<HTMLDialogElement>(".mobileComposerSettingsPanel")!;
    expect(panel.open).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    expect(panel.querySelectorAll('.mobileComposerSettingsControls')).toHaveLength(3);
    await act(() => (panel.querySelector(".v2ContextStatusButton") as HTMLButtonElement).click());
    expect(handler).toHaveBeenCalledOnce(); expect(panel.open).toBe(false);
    await act(() => trigger.click());
    let escaped = false;
    const outside = () => { escaped = true; };
    document.addEventListener("keydown", outside);
    await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    document.removeEventListener("keydown", outside);
    expect(escaped).toBe(false); expect(panel.open).toBe(true);
    expect(panel.dataset.closing).toBe("true");
    await act(() => vi.advanceTimersByTime(200));
    expect(panel.open).toBe(false);
    expect(document.body.style.overflow).toBe("");
    await act(() => trigger.click()); await act(() => render("second"));
    expect(panel.open).toBe(false);
  } finally { await act(() => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});

it("lists the desktop controls left to right as tasks, context, speed, model", () => {
  const html = renderToStaticMarkup(<MobileComposerSettings mobile={false} scope="thread" label="Astra"
    context={<button>上下文</button>} speed={<button>速度</button>} tasks={<button>任务</button>} model={<button>模型</button>} />);
  expect([...html.matchAll(/<button>(.*?)<\/button>/g)].map(match => match[1])).toEqual(["任务", "上下文", "速度", "模型"]);
});
