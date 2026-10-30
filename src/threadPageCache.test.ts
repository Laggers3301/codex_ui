import { expect, it } from "vitest";
import { isUsableThreadPage } from "./threadPageCache";
it("reuses a valid byte-budget-limited page instead of assuming 128 records", () => {
  expect(isUsableThreadPage({ totalItems:5000,returnedItems:3,before:0,nextBefore:3,hasOlder:true,nextCursor:"older" })).toBe(true);
  expect(isUsableThreadPage({ totalItems:2,returnedItems:2,before:0,nextBefore:2,hasOlder:false })).toBe(true);
});
it("still rejects empty or unreachable older-page cache entries", () => {
  expect(isUsableThreadPage({ totalItems:0,returnedItems:0,before:0,nextBefore:0,hasOlder:false })).toBe(false);
  expect(isUsableThreadPage({ totalItems:50,returnedItems:0,before:0,nextBefore:0,hasOlder:true })).toBe(false);
  expect(isUsableThreadPage({ totalItems:50,returnedItems:3,before:0,nextBefore:0,hasOlder:true })).toBe(false);
});
