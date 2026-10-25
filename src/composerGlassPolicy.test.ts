import { expect, it } from "vitest";
import { composerGlassMode } from "./composerGlassPolicy";
it("does not force small-screen/touch Chromium or a busy client to lite mode", () => {
  expect(composerGlassMode("Chrome/146 Windows",false)).toBe("original");
  expect(composerGlassMode("Android Chrome/146 Mobile",false)).toBe("original");
});
it("distinguishes browser limitations from a quality downgrade", () => {
  expect(composerGlassMode("iPhone AppleWebKit Safari/605",false)).toBe("browser-partial");
  expect(composerGlassMode("iPhone CriOS/146",false)).toBe("browser-partial");
  expect(composerGlassMode("Firefox/146",false)).toBe("browser-partial");
});
it("still honours the explicit accessibility preference", () => {
  expect(composerGlassMode("Chrome/146",true)).toBe("reduced-motion");
});
