// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createMobileLayers } from "./mobileLayers";

function fixture() {
  const host = new EventTarget() as Window;
  const history: any[] = [{ route: "chat" }]; let index = 0;
  Object.defineProperty(host, "location", { value: { href: "https://example.test/?thread=original" } });
  const back = vi.fn(() => { queueMicrotask(() => { if (index) index--; host.dispatchEvent(new Event("popstate")); }); });
  Object.defineProperty(host, "history", { value: {
    get state() { return history[index]; },
    pushState(value: any) { history.splice(index + 1); history.push(value); index++; },
    replaceState(value: any) { history[index] = value; },
    back,
  } });
  return { host, manager: createMobileLayers(host), history, back, getIndex: () => index, forwardEntries: () => history.length - 1 - index };
}

it("uses one fence for nested panels, closes only the top layer on system Back, then retains the conversation", async () => {
  const f = fixture(); let removeOuter = () => {}, removeInner = () => {};
  const outer = vi.fn(() => removeOuter()), inner = vi.fn(() => removeInner());
  removeOuter = f.manager.register(outer); removeInner = f.manager.register(inner);
  expect(f.history).toHaveLength(2);
  f.host.history.back(); await Promise.resolve();
  expect(inner).toHaveBeenCalledOnce(); expect(outer).not.toHaveBeenCalled();
  // The surviving layer is fenced again, so the next Back closes it too.
  expect(f.getIndex()).toBe(1);
  f.host.history.back(); await Promise.resolve();
  expect(outer).toHaveBeenCalledOnce(); expect(f.getIndex()).toBe(0);
  f.manager.dispose();
});

it("closing from the UI never navigates and leaves no forward entry for iOS to turn into a swipe", () => {
  const f = fixture();
  for (let cycle = 0; cycle < 3; cycle++) {
    const remove = f.manager.register(() => {});
    expect(f.history).toHaveLength(2); expect(f.history.at(-1).active).toBe(true);
    remove();
    expect(f.history.at(-1).active).toBe(false);
  }
  expect(f.back).not.toHaveBeenCalled();
  expect(f.getIndex()).toBe(1); expect(f.forwardEntries()).toBe(0); expect(f.history).toHaveLength(2);
  f.manager.dispose();
});

it("ignores a Back that lands on a parked fence and a replayed forward entry", async () => {
  const f = fixture(), close = vi.fn(); const remove = f.manager.register(close); remove();
  f.host.dispatchEvent(new Event("popstate"));
  expect(close).not.toHaveBeenCalled();
  f.manager.dispose();
});

it("consumes Escape while a panel is open, respects IME, and can register again after StrictMode cleanup", () => {
  const f = fixture(), close = vi.fn(); const remove = f.manager.register(close);
  const composing = new KeyboardEvent("keydown", { key: "Escape", isComposing: true, cancelable: true });
  f.host.dispatchEvent(composing); expect(close).not.toHaveBeenCalled();
  const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
  f.host.dispatchEvent(escape); expect(close).toHaveBeenCalledOnce(); expect(escape.defaultPrevented).toBe(true);
  remove(); f.manager.dispose(); f.manager.register(close);
  f.host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(close).toHaveBeenCalledTimes(2); f.manager.dispose();
});

it("does not navigate or duplicate the fence when StrictMode disposes after child cleanup", () => {
  const f = fixture(); const remove = f.manager.register(() => {});
  remove(); f.manager.dispose();
  expect(f.back).not.toHaveBeenCalled();
  f.manager.register(() => {});
  expect(f.history).toHaveLength(2); expect(f.history.at(-1).active).toBe(true);
  f.manager.dispose();
});

it("never touches session history on iOS, so neither screen edge becomes a system page swipe", () => {
  const f = fixture();
  Object.defineProperty(f.host, "navigator", { value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", platform: "iPhone", maxTouchPoints: 5 } });
  const manager = createMobileLayers(f.host), close = vi.fn();
  const remove = manager.register(close); const removeInner = manager.register(() => {});
  expect(f.history).toHaveLength(1); removeInner(); remove();
  expect(f.history).toHaveLength(1); expect(f.back).not.toHaveBeenCalled(); expect(f.getIndex()).toBe(0);
  const again = manager.register(close);
  f.host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(close).toHaveBeenCalledOnce(); again(); manager.dispose();
});
