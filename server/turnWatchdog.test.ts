import { describe, expect, it } from "vitest";
import { meaningfulTurnProgressMethod, TurnWatchdog } from "./turnWatchdog.js";

describe("TurnWatchdog", () => {
  it("diagnoses after two quiet minutes and resets only on real turn progress", () => {
    const watchdog = new TurnWatchdog();
    const start = 1_000_000;
    watchdog.start("user-a", "account-a", "thread-a", "turn-a", start);

    expect(watchdog.claimDueProbes(start + 119_999)).toEqual([]);
    const first = watchdog.claimDueProbes(start + 120_000);
    expect(first).toHaveLength(1);
    expect(first[0]?.shouldDiagnose).toBe(true);
    expect(first[0]?.turn.lastProgressAt).toBe(start);
    expect(watchdog.resolveProbe("user-a", "account-a", "thread-a", "turn-a", first[0]!.token, "active", [])?.turn.lastProgressAt).toBe(start);

    const resumed = watchdog.progress("user-a", "account-a", "thread-a", "turn-a", "item/agentMessage/delta", start + 130_000);
    expect(resumed?.resumed).toBe(true);
    expect(resumed?.turn.lastProgressAt).toBe(start + 130_000);
    expect(watchdog.claimDueProbes(start + 249_999)).toEqual([]);
    expect(watchdog.claimDueProbes(start + 250_000)[0]?.shouldDiagnose).toBe(true);
  });

  it("ignores an in-flight probe when fresh progress arrives on the same turn", () => {
    const watchdog = new TurnWatchdog();
    const start = 2_000_000;
    watchdog.start("user-a", "account-a", "thread-a", "turn-a", start);
    const claim = watchdog.claimDueProbes(start + 120_000)[0]!;
    expect(claim.turn.probeToken).toBe(claim.token);

    watchdog.progress("user-a", "account-a", "thread-a", "turn-a", "item/agentMessage/delta", start + 121_000);
    expect(claim.turn.probeToken).toBeNull();
    expect(watchdog.resolveProbe("user-a", "account-a", "thread-a", "turn-a", claim.token, "active", ["waitingOnApproval"])).toBeNull();
    expect(claim.turn.lastProgressAt).toBe(start + 121_000);
    expect(claim.turn.phase).toBe("running");
  });

  it("keeps approval, long-tool, and subagent waits diagnostic-only", () => {
    const watchdog = new TurnWatchdog();
    const turn = watchdog.start("user-a", "account-a", "thread-a", "turn-a", 5_000);
    watchdog.setPhase("user-a", "account-a", "thread-a", "turn-a", "waiting_approval");
    expect(watchdog.claimDueProbes(125_000)[0]?.turn.phase).toBe("waiting_approval");
    watchdog.resolveProbe("user-a", "account-a", "thread-a", "turn-a", turn.probeToken!, "active", []);
    expect(turn.phase).toBe("waiting_approval");

    watchdog.progress("user-a", "account-a", "thread-a", "turn-a", "item/commandExecution/started", 130_000);
    watchdog.setPhase("user-a", "account-a", "thread-a", "turn-a", "tool_running");
    const toolProbe = watchdog.claimDueProbes(250_000)[0];
    expect(toolProbe?.turn.phase).toBe("tool_running");
    watchdog.resolveProbe("user-a", "account-a", "thread-a", "turn-a", toolProbe!.token, "active", []);
    watchdog.progress("user-a", "account-a", "thread-a", "turn-a", "item/collabAgentToolCall/started", 260_000);
    watchdog.setPhase("user-a", "account-a", "thread-a", "turn-a", "waiting_subagents");
    expect(watchdog.claimDueProbes(380_000)[0]?.turn.phase).toBe("waiting_subagents");
    expect(meaningfulTurnProgressMethod({ method: "turn/read" })).toBeNull();
    expect(meaningfulTurnProgressMethod({ method: "websocket.ping" })).toBeNull();
    expect(meaningfulTurnProgressMethod({ method: "item/agentMessage/delta", params: { delta: "token" } })).toBe("item/agentMessage/delta");
  });

  it("isolates user/account identities and invalidates a replaced turn's in-flight probe", () => {
    const watchdog = new TurnWatchdog();
    const startedAt = 10_000;
    watchdog.start("user-a", "account-a", "thread-a", "turn-a", startedAt);
    watchdog.start("user-b", "account-a", "thread-a", "turn-b", startedAt);
    watchdog.start("user-a", "account-b", "thread-a", "turn-c", startedAt);
    expect(watchdog.activeForAccount("account-a").map((turn) => turn.userId)).toEqual(["user-a", "user-b"]);

    const oldProbe = watchdog.claimDueProbes(startedAt + 120_000).find((claim) => claim.turn.userId === "user-a" && claim.turn.accountId === "account-a")!;
    watchdog.start("user-a", "account-a", "thread-a", "turn-new", startedAt + 121_000);
    expect(watchdog.resolveProbe("user-a", "account-a", "thread-a", "turn-a", oldProbe.token, "active", [])).toBeNull();
    expect(watchdog.get("user-a", "account-a", "thread-a")?.turnId).toBe("turn-new");
    expect(watchdog.finish("user-a", "account-a", "thread-a", "turn-a")).toBeNull();
    expect(watchdog.finish("user-b", "account-a", "thread-a", "turn-b")?.turnId).toBe("turn-b");
  });

  it("does not repeatedly diagnose while a probe is pending or during the probe cooldown", () => {
    const watchdog = new TurnWatchdog();
    watchdog.start("user-a", null, "thread-a", "turn-a", 0);
    const first = watchdog.claimDueProbes(120_000);
    expect(first).toHaveLength(1);
    expect(watchdog.claimDueProbes(121_000)).toEqual([]);
    watchdog.failProbe("user-a", null, "thread-a", "turn-a", first[0]!.token);
    const second = watchdog.claimDueProbes(179_999);
    expect(second).toEqual([]);
    const third = watchdog.claimDueProbes(180_000);
    expect(third).toHaveLength(1);
    expect(third[0]?.shouldDiagnose).toBe(false);
    expect(third[0]?.turn.lastProgressAt).toBe(0);
    expect(watchdog.diagnosedForUser("user-a")).toHaveLength(1);
    expect(watchdog.diagnosedForUser("other-user")).toEqual([]);
  });
});
