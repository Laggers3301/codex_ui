import { expect, it } from "vitest";
import { selectMenuPosition } from "./selectMenuPosition";

it("opens a footer access menu upward inside the viewport", () => {
  const position = selectMenuPosition({ left: 1000, right: 1110, top: 745, bottom: 779, width: 110 }, 230, 150, { width: 1280, height: 800 });
  expect(position.top + 150).toBeLessThanOrEqual(745 - 7);
  expect(position.left + position.width).toBeLessThanOrEqual(1280 - 8);
});

it("keeps header menus below their trigger and clamps horizontal edges", () => {
  const position = selectMenuPosition({ left: 4, right: 114, top: 12, bottom: 43, width: 110 }, 245, 150, { width: 393, height: 800 });
  expect(position.left).toBe(8);
  expect(position.top).toBe(50);
});

it("fits narrow visual viewports and gives long menus a scrolling height", () => {
  const position = selectMenuPosition({ left: 260, right: 390, top: 125, bottom: 159, width: 130 }, 245, 600, { width: 220, height: 220, left: 100, top: 20 });
  expect(position.left).toBeGreaterThanOrEqual(108);
  expect(position.left + position.width).toBeLessThanOrEqual(312);
  expect(position.top).toBeGreaterThanOrEqual(28);
  expect(position.top + position.maxHeight).toBeLessThanOrEqual(232);
});
