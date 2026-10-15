import { describe, expect, it } from "vitest";
import { exactSearchTurn, waitForSearchTarget } from "./searchNavigation";
import type { ThreadSummary } from "./types";

describe("exact search navigation", () => {
  it("selects the exact ID even when earlier messages share the keyword", () => {
    const thread = { turns: [{ id: 'old', items: [{ id: 'wrong' }] }, { id: 'hit', items: [{ id: 'exact' }] }] } as ThreadSummary;
    expect(exactSearchTurn(thread, 'exact')).toBe('hit');
    expect(exactSearchTurn(thread, 'missing')).toBeNull();
  });
  it("waits for virtual mount without dropping identity or loading history", async () => {
    let frame = 0, scrolls = 0;
    const target = { id: 'exact' };
    const found = await waitForSearchTarget({ getTarget: () => frame >= 6 ? target : undefined,
      scrollToTurn: () => { scrolls++; }, isCurrent: () => true,
      nextFrame: async () => { frame++; }, now: () => frame * 16 });
    expect(found).toBe(target);
    expect(scrolls).toBe(2);
  });
  it("cancels when a different navigation supersedes the jump", async () => {
    const found = await waitForSearchTarget({ getTarget: () => ({ id: 'stale' }), scrollToTurn: () => {},
      isCurrent: () => false, nextFrame: async () => {} });
    expect(found).toBeNull();
  });
});
