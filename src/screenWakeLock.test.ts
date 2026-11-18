// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { holdScreenAwake } from "./screenWakeLock";

type Fake = { released: boolean; release: () => Promise<void>; addEventListener: (type: string, fn: () => void) => void; fire: () => void };
const makeLock = (): Fake => {
  const listeners: (() => void)[] = [];
  const lock: Fake = { released: false, release: async () => { lock.released = true; }, addEventListener: (_type, fn) => { listeners.push(fn); }, fire: () => { lock.released = true; listeners.forEach(fn => fn()); } };
  return lock;
};
const install = (request: () => Promise<Fake>) => Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { Reflect.deleteProperty(navigator, "wakeLock"); vi.restoreAllMocks(); });

it("holds the lock while dictating and lets the screen sleep afterwards", async () => {
  const lock = makeLock(); const request = vi.fn(async () => lock); install(request);
  const stop = holdScreenAwake(); await flush();
  expect(request).toHaveBeenCalledWith("screen");
  stop(); await flush();
  expect(lock.released).toBe(true);
});

it("takes the lock again after the browser drops it when the page was hidden", async () => {
  const first = makeLock(), second = makeLock(); const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second); install(request);
  const stop = holdScreenAwake(); await flush();
  first.fire(); document.dispatchEvent(new Event("visibilitychange")); await flush();
  expect(request).toHaveBeenCalledTimes(2);
  stop(); await flush(); expect(second.released).toBe(true);
});

it("releases a lock that arrives after the user already stopped", async () => {
  const lock = makeLock(); let grant: (value: Fake) => void = () => {};
  install(() => new Promise<Fake>(resolve => { grant = resolve; }));
  const stop = holdScreenAwake(); stop(); grant(lock); await flush();
  expect(lock.released).toBe(true);
});

it("never throws when the browser refuses or has no wake lock", async () => {
  install(async () => { throw new DOMException("denied", "NotAllowedError"); });
  expect(() => holdScreenAwake()()).not.toThrow(); await flush();
  Reflect.deleteProperty(navigator, "wakeLock");
  expect(() => holdScreenAwake()()).not.toThrow();
});
