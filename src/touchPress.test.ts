// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installDeferredTouchPress, longPressDelay, SIDEBAR_SWIPE_EVENT, TOUCH_LONG_PRESS_MS, TOUCH_PRESS_DELAY_MS } from "./touchPress";

const pointer = (type: string, target: Element, init: { x?: number; y?: number; kind?: string } = {}) => {
  const event = new MouseEvent(type, { bubbles: true, clientX: init.x ?? 0, clientY: init.y ?? 0 });
  Object.assign(event, { pointerType: init.kind ?? "touch", pointerId: 1 });
  target.dispatchEvent(event);
};
let stop: () => void;
beforeEach(() => { vi.useFakeTimers(); document.body.innerHTML = `<div class="threadRow" id="row"><button id="inner">x</button></div>`; stop = installDeferredTouchPress(); });
afterEach(() => { stop(); vi.useRealTimers(); });

it("holds a touch long press for about half a second and a mouse press for less", () => {
  expect(longPressDelay("touch")).toBe(TOUCH_LONG_PRESS_MS);
  expect(longPressDelay("pen")).toBe(TOUCH_LONG_PRESS_MS);
  expect(longPressDelay("mouse")).toBeLessThan(TOUCH_LONG_PRESS_MS);
});

it("shows the pressed look only after a stationary touch", () => {
  const row = document.getElementById("row")!;
  pointer("pointerdown", document.getElementById("inner")!);
  vi.advanceTimersByTime(TOUCH_PRESS_DELAY_MS - 10);
  expect(row.hasAttribute("data-pressed")).toBe(false);
  vi.advanceTimersByTime(20);
  expect(row.hasAttribute("data-pressed")).toBe(true);
  pointer("pointerup", row);
  expect(row.hasAttribute("data-pressed")).toBe(false);
});

it("never flashes for a swipe: moving past the slop or a drawer swipe withdraws the press", () => {
  const row = document.getElementById("row")!;
  pointer("pointerdown", row, { x: 100, y: 50 });
  pointer("pointermove", row, { x: 104, y: 52 });
  vi.advanceTimersByTime(TOUCH_PRESS_DELAY_MS + 10);
  expect(row.hasAttribute("data-pressed")).toBe(true); // a small wobble is still a press
  pointer("pointermove", row, { x: 120, y: 50 });
  expect(row.hasAttribute("data-pressed")).toBe(false);
  pointer("pointerdown", row, { x: 100, y: 50 });
  window.dispatchEvent(new Event(SIDEBAR_SWIPE_EVENT));
  vi.advanceTimersByTime(TOUCH_PRESS_DELAY_MS + 10);
  expect(row.hasAttribute("data-pressed")).toBe(false);
});

it("ignores mouse presses", () => {
  const row = document.getElementById("row")!;
  pointer("pointerdown", row, { kind: "mouse" });
  vi.advanceTimersByTime(500);
  expect(row.hasAttribute("data-pressed")).toBe(false);
});
