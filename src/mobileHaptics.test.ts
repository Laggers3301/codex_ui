// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mobileHaptic } from "./mobileHaptics";
afterEach(() => vi.unstubAllGlobals());
it("is a no-op on browsers without a vibration API", () => {
  vi.stubGlobal("navigator", {});
  expect(mobileHaptic(1000)).toBe(false);
});
it("uses one short, throttled pulse on supported mobile browsers", () => {
  const vibrate = vi.fn(() => true);
  vi.stubGlobal("navigator", { vibrate, userActivation: { isActive: true } });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: coarse") }));
  expect(mobileHaptic(2000)).toBe(true); expect(mobileHaptic(2100)).toBe(false); expect(mobileHaptic(2200)).toBe(true);
  expect(vibrate.mock.calls).toEqual([[8], [8]]);
});
it("never vibrates in reduced-motion mode or lets a rejected API break clicks", () => {
  vi.stubGlobal("navigator", { vibrate: () => { throw new Error("not permitted"); } });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  expect(mobileHaptic(3000)).toBe(false);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: coarse") }));
  expect(mobileHaptic(3200)).toBe(false);
});
