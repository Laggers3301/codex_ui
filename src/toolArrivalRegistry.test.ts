import { describe, expect, it } from "vitest";
import { ToolArrivalRegistry } from "./toolArrivalRegistry";
describe("tool arrival identity", () => {
  it("animates a new receipt regardless of server timestamp or completion", () => {
    const registry = new ToolArrivalRegistry();
    registry.receive("delayed-completed-tool", 3);
    expect(registry.belongsToLiveView("delayed-completed-tool", 3)).toBe(true);
    registry.snapshot(["delayed-completed-tool"]);
    expect(registry.belongsToLiveView("delayed-completed-tool", 3)).toBe(true);
  });
  it("does not replay restored history, reconnects or a different view", () => {
    const registry = new ToolArrivalRegistry();
    registry.snapshot(["restored"]); registry.receive("restored", 3);
    expect(registry.belongsToLiveView("restored", 3)).toBe(false);
    registry.receive("new", 3);
    expect(registry.belongsToLiveView("new", 4)).toBe(false);
    registry.receive("background", null);
    expect(registry.belongsToLiveView("background", 3)).toBe(false);
  });
});
