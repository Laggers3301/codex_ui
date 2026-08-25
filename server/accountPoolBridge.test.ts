import { describe, expect, it } from "vitest";
import { selectAccountCandidate, type AccountRoutingCandidate } from "./accountPoolBridge.js";

function candidate(
  id: string,
  remainingPercent: number,
  overrides: Partial<AccountRoutingCandidate> = {}
): AccountRoutingCandidate {
  return {
    id,
    health: "ready",
    remainingPercent,
    activeRequests: 0,
    assignedThreadCount: 0,
    ...overrides
  };
}

describe("account-pool routing policy", () => {
  it("always gives a new thread to the healthy account with more remaining quota", () => {
    const selected = selectAccountCandidate([
      candidate("260803", 65, { activeRequests: 8, assignedThreadCount: 100 }),
      candidate("260707", 53)
    ]);
    expect(selected.id).toBe("260803");
  });

  it("excludes a degraded account even when it has more quota", () => {
    const selected = selectAccountCandidate([
      candidate("degraded", 100, { health: "degraded" }),
      candidate("healthy", 20)
    ]);
    expect(selected.id).toBe("healthy");
  });

  it("uses active requests and then assigned threads only for equal-quota ties", () => {
    expect(selectAccountCandidate([
      candidate("busy", 80, { activeRequests: 2 }),
      candidate("idle", 80, { activeRequests: 0, assignedThreadCount: 10 })
    ]).id).toBe("idle");

    expect(selectAccountCandidate([
      candidate("many", 80, { assignedThreadCount: 11 }),
      candidate("few", 80, { assignedThreadCount: 3 })
    ]).id).toBe("few");
  });

  it("prefers a known zero-percent balance over an unknown balance", () => {
    expect(selectAccountCandidate([
      candidate("unknown", -1),
      candidate("known", 0)
    ]).id).toBe("known");
  });

  it("still chooses deterministically when every account is degraded", () => {
    expect(selectAccountCandidate([
      candidate("lower", 10, { health: "degraded" }),
      candidate("higher", 20, { health: "degraded" })
    ]).id).toBe("higher");
  });

  it("rejects an empty account pool", () => {
    expect(() => selectAccountCandidate([])).toThrow(/no routing candidates/i);
  });
});
