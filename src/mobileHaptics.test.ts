// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { haptic, hapticKindFor, mobileHaptic, mobileShapeHaptic, setHapticsEnabled } from "./mobileHaptics";

const touch = (extra: Record<string, unknown> = {}) => vi.stubGlobal("navigator", { userActivation: { isActive: true }, ...extra });
const coarse = (reduced = false) => vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") ? reduced : query.includes("pointer: coarse") }));
const memory = new Map<string, string>();
// Node's own experimental localStorage can shadow jsdom's; the module only needs get/set/remove.
Object.defineProperty(window, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value), removeItem: (key: string) => void memory.delete(key) } });
beforeEach(() => { memory.clear(); document.body.innerHTML = ""; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("never plays on a mouse device, or where nothing can play", () => {
  touch({ vibrate: vi.fn(() => true) });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  expect(haptic("tap", 1000)).toBe(false);
  vi.unstubAllGlobals(); vi.stubGlobal("navigator", {});
  expect(mobileHaptic(1000)).toBe(false);
});

it("uses a short pattern per kind with a minimum gap on vibration-capable browsers", () => {
  const vibrate = vi.fn(() => true);
  touch({ vibrate }); coarse();
  expect(haptic("tap", 2000)).toBe(true);
  expect(haptic("select", 2100)).toBe(false);
  expect(haptic("snap", 2200)).toBe(true);
  expect(haptic("success", 2400)).toBe(true);
  expect(mobileShapeHaptic(2600)).toBe(true);
  expect(vibrate.mock.calls).toEqual([[8], [12], [[8, 55, 12]], [12]]);
});

it("needs a live user gesture and never lets a rejected API break the UI", () => {
  touch({ vibrate: () => { throw new Error("not permitted"); } }); coarse();
  expect(haptic("tap", 3000)).toBe(false);
  touch({ vibrate: vi.fn(() => true), userActivation: { isActive: false } });
  expect(haptic("tap", 3200)).toBe(false);
  touch({ vibrate: vi.fn(() => true) }); coarse(true);
  expect(haptic("tap", 3400)).toBe(false);
});

it("uses the native switch haptic on iOS without moving focus, with a second tick for success", () => {
  vi.useFakeTimers();
  touch(); coarse();
  const clicks: string[] = [];
  document.addEventListener("click", event => clicks.push((event.target as Element).tagName), true);
  const input = document.createElement("textarea"); document.body.append(input); input.focus();
  expect(haptic("snap", 10_000)).toBe(true);
  expect(clicks).toEqual(["LABEL", "INPUT"]);
  expect(document.activeElement).toBe(input);
  expect(document.head.querySelector("input[switch]")).toBeNull();
  expect(haptic("tap", 10_050)).toBe(false);
  expect(haptic("success", 10_300)).toBe(true);
  const first = clicks.length;
  vi.advanceTimersByTime(80);
  expect(clicks.length).toBe(first + 2);
});

it("can be switched off by the user and back on", () => {
  const vibrate = vi.fn(() => true);
  touch({ vibrate }); coarse();
  setHapticsEnabled(false);
  expect(haptic("tap", 20_000)).toBe(false);
  setHapticsEnabled(true);
  expect(haptic("tap", 20_200)).toBe(true);
  expect(vibrate).toHaveBeenCalledTimes(1);
});

it("picks the feel from the control that was pressed", () => {
  document.body.innerHTML = `<div>
    <button id="plain"><span id="inner">x</span></button><button id="off" disabled>x</button><div data-haptic="off"><button id="muted">x</button></div>
    <button id="send" class="mobileUiSendButton">x</button><button id="copy" aria-label="复制回答">x</button>
    <button id="toggle" aria-pressed="false">x</button><div role="tab" id="tab">x</div><input id="check" type="checkbox"><textarea id="text"></textarea>
    <div class="messageMarkdown"><a id="reading" href="https://example.com">link</a></div><a id="chrome" href="/x">go</a></div>`;
  const kind = (id: string) => hapticKindFor(document.getElementById(id));
  expect(kind("plain")).toBe("tap"); expect(kind("inner")).toBe("tap");
  expect(kind("off")).toBeNull(); expect(kind("muted")).toBeNull();
  expect(kind("send")).toBe("snap"); expect(kind("copy")).toBe("success");
  expect(kind("toggle")).toBe("select"); expect(kind("tab")).toBe("select"); expect(kind("check")).toBe("select");
  expect(kind("text")).toBeNull(); expect(kind("reading")).toBeNull(); expect(kind("chrome")).toBe("tap");
  expect(hapticKindFor(null)).toBeNull();
});
