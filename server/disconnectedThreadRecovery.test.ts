import { describe, expect, it, vi } from "vitest";
import { isDisconnectedStreamError, prepareDisconnectedThreadRetry } from "./disconnectedThreadRecovery.js";

describe("disconnected thread recovery", () => {
  it("distinguishes interrupted streams from auth and quota failures", () => {
    expect(isDisconnectedStreamError({ message: "stream disconnected before completion: stream closed before response.completed" })).toBe(true);
    expect(isDisconnectedStreamError({ codexErrorInfo: "ResponseStreamDisconnected" })).toBe(true);
    expect(isDisconnectedStreamError({ message: "refresh_token_reused" })).toBe(false);
    expect(isDisconnectedStreamError({ message: "UsageLimitExceeded" })).toBe(false);
  });
  it.each(["idle", "systemError", "notLoaded"])("permits retry from terminal %s without unsubscribe or prompt replay", async status => {
    const request = vi.fn().mockResolvedValue({ thread: { status: { type: status } } });
    const failed = new Set(["broken", "another"]);
    await prepareDisconnectedThreadRetry({ request }, failed, "healthy");
    expect(request).not.toHaveBeenCalled();
    await prepareDisconnectedThreadRetry({ request }, failed, "broken");
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/read"]);
    expect(failed).toEqual(new Set(["another"]));
  });
  it.each(["active", "waitingOnApproval", undefined])("refuses unsafe or unknown %s runtime state", async status => {
    const failed = new Set(["broken"]);
    const request = vi.fn().mockResolvedValue({ thread: { status: { type: status } } });
    await expect(prepareDisconnectedThreadRetry({ request }, failed, "broken")).rejects.toThrow("仍在运行");
    expect(request).toHaveBeenCalledTimes(1);
    expect(failed.has("broken")).toBe(true);
  });
  it("retains the failure marker when checking runtime fails", async () => {
    const failed = new Set(["broken"]);
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(prepareDisconnectedThreadRetry({ request }, failed, "broken")).rejects.toThrow("offline");
    expect(failed.has("broken")).toBe(true);
  });
});
