import { describe, expect, it } from "vitest";
import { resolvePromptTopAnchor } from "./promptTopAnchor";

const anchor = { requestId: "first", threadId: "thread", turnId: "turn", viewToken: 1 };
describe("last-question top reserve", () => {
  it("reserves space for an ordinary newly sent question", () => {
    expect(resolvePromptTopAnchor(anchor, 1, "thread", "turn", 1, [])).toEqual({ turnId: "turn", liveTail: false });
  });
  it("does not reserve space ahead of a pending steer", () => {
    expect(resolvePromptTopAnchor(anchor, 1, "thread", "turn", 1, ["steer"])).toEqual({ turnId: null, liveTail: false });
  });
  it("does not restore the old reserve after the steer is persisted in the same turn", () => {
    expect(resolvePromptTopAnchor(anchor, 1, "thread", "turn", 2, [])).toEqual({ turnId: null, liveTail: false });
  });
  it("drops the reserve when the queue starts a new turn", () => {
    expect(resolvePromptTopAnchor(anchor, 1, "thread", "next", 1, [])).toEqual({ turnId: null, liveTail: false });
  });
  it("anchors an optimistic new question before its turn arrives", () => {
    expect(resolvePromptTopAnchor({ ...anchor, turnId: null }, 1, "thread", "old", 1, ["first"])).toEqual({ turnId: null, liveTail: true });
  });
  it("cannot carry a reserve into a different view", () => {
    expect(resolvePromptTopAnchor(anchor, 2, "thread", "turn", 1, [])).toEqual({ turnId: null, liveTail: false });
    expect(resolvePromptTopAnchor(anchor, 1, "other", "turn", 1, [])).toEqual({ turnId: null, liveTail: false });
  });
});
