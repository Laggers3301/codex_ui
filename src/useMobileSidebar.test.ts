import { describe, expect, it } from "vitest";
import { sidebarSwipeIntent } from "./useMobileSidebar";
describe("mobile drawer gesture arbitration", () => {
  it("waits for intent instead of treating a tap as a swipe", () => {
    expect(sidebarSwipeIntent(4, 3, false)).toBe("wait");
  });
  it("never intercepts vertical reading scrolls", () => {
    expect(sidebarSwipeIntent(10, 30, false)).toBe("ignore");
    expect(sidebarSwipeIntent(-10, -30, true)).toBe("ignore");
  });
  it("opens rightwards and closes leftwards only", () => {
    expect(sidebarSwipeIntent(20, 2, false)).toBe("drag");
    expect(sidebarSwipeIntent(-20, 2, true)).toBe("drag");
    expect(sidebarSwipeIntent(-20, 2, false)).toBe("ignore");
    expect(sidebarSwipeIntent(20, 2, true)).toBe("ignore");
  });
});
