// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { readMobileResume, writeMobileResume } from "./mobileResume";

beforeEach(() => sessionStorage.clear());
it("restores only the same user's last view and clears deliberate new chats", () => {
  const value = { projectId: "project", threadId: "thread" };
  writeMobileResume(sessionStorage, "one", value);
  expect(readMobileResume(sessionStorage, "one")).toEqual(value);
  expect(readMobileResume(sessionStorage, "two")).toBeNull();
  writeMobileResume(sessionStorage, "one", null);
  expect(readMobileResume(sessionStorage, "one")).toBeNull();
});
it("ignores malformed or unavailable storage", () => {
  sessionStorage.setItem("codex-mobile-resume:one", "{broken");
  expect(readMobileResume(sessionStorage, "one")).toBeNull();
  sessionStorage.setItem("codex-mobile-resume:one", '{"threadId":42}');
  expect(readMobileResume(sessionStorage, "one")).toBeNull();
  const unavailable = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } } as unknown as Storage;
  expect(readMobileResume(unavailable, "one")).toBeNull();
  expect(() => writeMobileResume(unavailable, "one", null)).not.toThrow();
});
