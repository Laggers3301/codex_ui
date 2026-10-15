import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexBridge } from "./codexBridge.js";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import { validateUserInputResponse } from "./userInput.js";

describe("native question request lifecycle", () => {
  it("removes requests cleared by native completion or interruption before reconnect", () => {
    const bridge = new CodexBridge();
    const receive = (message: unknown) => (bridge as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(message));
    receive({ id: 17, method: "item/tool/requestUserInput", params: { threadId: "thread-a", itemId: "call-q" } });
    expect(bridge.getPendingServerRequests()).toHaveLength(1);
    receive({ method: "serverRequest/resolved", params: { threadId: "thread-a", requestId: 17 } });
    expect(bridge.getPendingServerRequests()).toEqual([]);
  });

  it("maps cancellation IDs to their account-scoped public IDs", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "question-pool-"));
    class FakeBridge extends EventEmitter {
      pending: any[] = [];
      responses: unknown[] = [];
      getPendingServerRequests() { return this.pending; }
      async start() {}
      stop() {}
      respondToServerRequest(id: unknown, result: unknown) {
        this.responses.push({ id, result });
        this.pending = this.pending.filter(request => request.id !== id);
      }
    }
    const first = new FakeBridge(), second = new FakeBridge();
    const fakes = [first, second]; let index = 0;
    for (const id of ["a", "b"]) fs.mkdirSync(path.join(directory, id));
    const pool = new AccountPoolBridge({ accounts: [{ id: "a", label: "A", codexHome: path.join(directory, "a") }, { id: "b", label: "B", codexHome: path.join(directory, "b") }], stateFile: "state.json" }, directory, () => fakes[index++] as unknown as CodexBridge);
    try {
      const requests: any[] = [], notifications: any[] = [];
      pool.on("serverRequest", request => requests.push(request));
      pool.on("notification", message => notifications.push(message));
      for (const [account, bridge] of [["a", first], ["b", second]] as const) {
        const request = { id: 17, method: "item/tool/requestUserInput", params: { threadId: `thread-${account}`, turnId: `turn-${account}`, itemId: `call-${account}`, questions: [] }, receivedAt: "2026-10-14T00:00:00Z" };
        bridge.pending.push(request); bridge.emit("serverRequest", request);
      }
      expect(requests[0].id).not.toBe(requests[1].id);
      first.pending = [];
      first.emit("notification", { method: "serverRequest/resolved", params: { threadId: "thread-a", requestId: 17 } });
      expect(notifications[0]).toMatchObject({ accountId: "a", params: { requestId: requests[0].id, threadId: "thread-a" } });
      expect(pool.getPendingServerRequests().map(request => request.id)).toEqual([requests[1].id]);
      expect(() => pool.respondToServerRequest(requests[0].id, { answers: {} })).toThrow();
      pool.respondToServerRequest(requests[1].id, { answers: {} });
      expect(second.responses).toEqual([{ id: 17, result: { answers: {} } }]);
    } finally { pool.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects unrelated question IDs without resolving a pending request", () => {
    expect(() => validateUserInputResponse({ questions: [{ id: "robot" }] }, { answers: { robot: { answers: ["A"] }, foreign: { answers: ["B"] } } })).toThrow();
    expect(() => validateUserInputResponse({ questions: [{ id: "robot" }, { id: "robot" }] }, { answers: { robot: { answers: ["A"] } } })).toThrow();
  });
});
