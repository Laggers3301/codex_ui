// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function fixture(local = true) {
  vi.resetModules();
  const observers: { callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("CSS", local ? { registerProperty: vi.fn() } : {});
  vi.stubGlobal("ResizeObserver", class {
    disconnect = vi.fn(); observe = vi.fn();
    constructor(callback: ResizeObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); }
  });
  const { observeComposerViewportMetrics } = await import("./composerViewportMetrics");
  const root = document.createElement("section");
  root.innerHTML = '<div class="messages"><article class="conversationTurnRow topAnchoredTurn"><p>正文</p></article></div><button class="scrollToBottomButton"></button><div class="threadOpeningLayer"></div><form class="composer"><div class="codexApprovalRequests"></div></form>';
  document.body.append(root);
  const composer = root.querySelector<HTMLElement>(".composer")!, messages = root.querySelector<HTMLElement>(".messages")!;
  const rect = vi.spyOn(composer, "getBoundingClientRect").mockReturnValue({ height: 100 } as DOMRect);
  Object.defineProperty(messages, "clientHeight", { configurable: true, value: 600 });
  const follow = vi.fn(), cleanup = observeComposerViewportMetrics(composer, messages, follow);
  const resize = (height: number) => observers[0].callback([{ borderBoxSize: [{ blockSize: height }] } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  return { root, composer, messages, rect, follow, cleanup, resize, observers };
}

it("publishes non-inherited metrics only to layout consumers, not history or its ancestor", async () => {
  const f = await fixture();
  expect(CSS.registerProperty).toHaveBeenCalledWith(expect.objectContaining({ name: "--composer-height", inherits: false }));
  expect(f.root.style.getPropertyValue("--composer-height")).toBe("");
  expect(f.messages.style.getPropertyValue("--composer-height")).toBe("100px");
  expect(f.root.querySelector<HTMLElement>("p")!.style.cssText).toBe("");
  expect(f.root.querySelector<HTMLElement>(".topAnchoredTurn")!.style.getPropertyValue("--messages-viewport-height")).toBe("600px");
  expect(f.messages.style.getPropertyValue("--messages-viewport-height")).toBe("");
  f.cleanup();
});
it("uses border-box observer measurements and ignores unchanged/subpixel/hidden sizes before writes", async () => {
  const f = await fixture(), calls = f.rect.mock.calls.length;
  f.resize(180); f.resize(180.1); f.resize(0);
  expect(f.rect).toHaveBeenCalledTimes(calls);
  expect(f.follow).toHaveBeenCalledTimes(2);
  expect(f.messages.style.getPropertyValue("--composer-height")).toBe("180px");
  f.cleanup();
});
it("initializes newly inserted cards and class-switched anchored turns without rescanning text", async () => {
  const f = await fixture(); f.resize(160);
  const card = document.createElement("div"); card.className = "codexApprovalRequests"; f.composer.append(card);
  const row = document.createElement("article"); row.className = "conversationTurnRow"; f.messages.append(row);
  await Promise.resolve(); row.classList.add("topAnchoredTurn"); await Promise.resolve();
  expect(card.style.getPropertyValue("--composer-height")).toBe("160px");
  expect(row.style.getPropertyValue("--composer-height")).toBe("160px");
  expect(row.style.getPropertyValue("--messages-viewport-height")).toBe("600px");
  row.classList.remove("topAnchoredTurn"); await Promise.resolve();
  expect(row.style.cssText).toBe("");
  card.remove(); await Promise.resolve(); expect(card.style.cssText).toBe("");
  f.cleanup();
});
it("does not publish detached or zero viewport measurements", async () => {
  const f = await fixture();
  Object.defineProperty(f.messages, "clientHeight", { value: 0 });
  f.observers[1].callback([], {} as ResizeObserver);
  expect(f.root.querySelector<HTMLElement>(".topAnchoredTurn")!.style.getPropertyValue("--messages-viewport-height")).toBe("600px");
  f.composer.remove(); f.resize(300);
  expect(f.messages.style.getPropertyValue("--composer-height")).toBe("100px"); f.cleanup();
});
it("disconnects observers and clears only its own inline metrics", async () => {
  const f = await fixture(); f.messages.style.color = "red"; f.cleanup();
  expect(f.observers.every(o => o.disconnect.mock.calls.length === 1)).toBe(true);
  expect(f.messages.style.getPropertyValue("--composer-height")).toBe("");
  expect(f.messages.style.color).toBe("red");
});
it("retains the legacy inherited fallback when registration is unavailable", async () => {
  const f = await fixture(false); f.resize(200);
  expect(f.root.style.getPropertyValue("--composer-height")).toBe("200px");
  expect(f.root.style.getPropertyValue("--messages-viewport-height")).toBe("600px");
  expect(f.messages.style.getPropertyValue("--composer-height")).toBe("");
  f.cleanup(); expect(f.root.style.cssText).toBe("");
});
