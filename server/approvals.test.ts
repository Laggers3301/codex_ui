import { describe, expect, it } from "vitest";
import { approvalDecisions, approvalResponse, isApprovalRequest, type ApprovalRequest } from "../shared/approvals";
import { CodexBridge } from "./codexBridge";
import { AccountPoolBridge } from "./accountPoolBridge";

describe("approval protocol", () => {
  const permission: ApprovalRequest = { id: "permissions", method: "item/permissions/requestApproval", params: {
    permissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/tmp/specified"], entries: [] } }
  } };
  it("grants only the requested permissions for the current turn, ignoring client-supplied scope", () => {
    expect(approvalResponse(permission, { decision: "accept", scope: "session", permissions: { fileSystem: { write: ["/"] } } }))
      .toEqual({ permissions: permission.params.permissions, scope: "turn" });
    expect(approvalResponse(permission, { decision: "decline" })).toEqual({ permissions: {}, scope: "turn" });
    expect(() => approvalResponse(permission, { decision: "acceptForSession" })).toThrow();
  });
  it("honors allowed command decisions without installing policy amendments", () => {
    const request = { id: 2, method: "item/commandExecution/requestApproval", params: { availableDecisions: ["cancel", "acceptForSession"] } };
    expect(approvalDecisions(request)).toEqual(["cancel", "acceptForSession"]);
    expect(() => approvalResponse(request, { decision: "accept" })).toThrow();
    expect(approvalResponse(request, { decision: "acceptForSession", execpolicy: ["sh"] })).toEqual({ decision: "acceptForSession" });
  });
  it("recognizes newer approval requests for display but never sends an unsupported response", () => {
    const request = { id: 3, method: "item/future/requestApproval", params: {} };
    expect(isApprovalRequest(request.method)).toBe(true);
    expect(approvalDecisions(request)).toEqual([]);
    expect(() => approvalResponse(request, { decision: "accept" })).toThrow();
    expect(isApprovalRequest("item/tool/requestUserInput")).toBe(false);
    expect(() => approvalResponse({ ...permission, params: {} }, { decision: "accept" })).toThrow();
  });
  it("preserves both native and pool pending requests when writing a decision fails", () => {
    const bridge = new CodexBridge({ command: "unused", args: [] });
    const pending = { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread-a" }, receivedAt: "now" };
    Object.assign(bridge, { serverRequests: new Map([[7, pending]]) });
    const pool = Object.create(AccountPoolBridge.prototype) as AccountPoolBridge;
    Object.assign(pool, { serverRequestAccounts: new Map([["pool-7", { bridge, originalId: 7, accountId: "account-a" }]]) });
    expect(() => pool.respondToServerRequest("pool-7", { decision: "decline" })).toThrow("not running");
    expect(pool.getPendingServerRequests()).toEqual([{ ...pending, id: "pool-7", accountId: "account-a" }]);
    expect(bridge.getPendingServerRequests()).toEqual([pending]);
    const writes: string[] = [];
    Object.assign(bridge, { proc: { stdin: { writable: true, write: (line: string) => writes.push(line) } } });
    pool.respondToServerRequest("pool-7", { decision: "decline" });
    expect(writes.map(line => JSON.parse(line))).toEqual([{ id: 7, result: { decision: "decline" } }]);
    expect(pool.getPendingServerRequests()).toEqual([]); expect(bridge.getPendingServerRequests()).toEqual([]);
  });
});
