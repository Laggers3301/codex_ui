import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { allowedAccountForUser, assertTrackedUserQuotaAvailable } from "./routes.js";

describe("lzc dedicated account policy", () => {
  it("allows 260901 regardless of the old 50% cap and rejects another account's thread", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lzc-account-"));
    const oldHome = path.join(temporary, "old");
    const allowedHome = path.join(temporary, "allowed");
    fs.mkdirSync(oldHome);
    fs.mkdirSync(allowedHome);
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const pool = new AccountPoolBridge({
      accounts: [
        { id: "260803", label: "260803", codexHome: oldHome },
        { id: "260901", label: "260901", codexHome: allowedHome }
      ],
      stateFile: "pool-state.json"
    }, temporary, () => Object.assign(new EventEmitter(), { stop() {} }) as unknown as CodexBridge);
    try {
      expect(allowedAccountForUser("LZC")).toBe("260901");
      expect(allowedAccountForUser("gyj")).toBeNull();
      pool.assignThreadsToAccount(["old-thread"], "260803");
      pool.assignThreadsToAccount(["allowed-thread"], "260901");
      await expect(assertTrackedUserQuotaAvailable(pool as unknown as CodexBridge, store, "lzc", "allowed-thread")).resolves.toBeUndefined();
      await expect(assertTrackedUserQuotaAvailable(pool as unknown as CodexBridge, store, "lzc", "old-thread")).rejects.toThrow(/只能使用 260901/);
    } finally {
      pool.stop();
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
