import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverConfig } from "./config.js";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { allowedAccountForUser, assertTrackedUserQuotaAvailable } from "./routes.js";

describe("quotaUser dedicated account policy", () => {
  const originalUser = serverConfig.trackedQuotaUser;
  const originalAccount = serverConfig.trackedQuotaAllowedAccountId;
  beforeEach(() => {
    serverConfig.trackedQuotaUser = "quotaUser";
    serverConfig.trackedQuotaAllowedAccountId = "account-c";
  });
  afterEach(() => {
    serverConfig.trackedQuotaUser = originalUser;
    serverConfig.trackedQuotaAllowedAccountId = originalAccount;
  });
  it("allows account-c regardless of the old 50% cap and rejects another account's thread", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-quotaUser-account-"));
    const oldHome = path.join(temporary, "old");
    const allowedHome = path.join(temporary, "allowed");
    fs.mkdirSync(oldHome);
    fs.mkdirSync(allowedHome);
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const pool = new AccountPoolBridge({
      accounts: [
        { id: "account-a", label: "account-a", codexHome: oldHome },
        { id: "account-c", label: "account-c", codexHome: allowedHome }
      ],
      stateFile: "pool-state.json"
    }, temporary, () => Object.assign(new EventEmitter(), { stop() {} }) as unknown as CodexBridge);
    try {
      expect(allowedAccountForUser("QUOTAUSER")).toBe("account-c");
      expect(allowedAccountForUser("qaUser")).toBeNull();
      pool.assignThreadsToAccount(["old-thread"], "account-a");
      pool.assignThreadsToAccount(["allowed-thread"], "account-c");
      await expect(assertTrackedUserQuotaAvailable(pool as unknown as CodexBridge, store, "quotaUser", "allowed-thread")).resolves.toBeUndefined();
      await expect(assertTrackedUserQuotaAvailable(pool as unknown as CodexBridge, store, "quotaUser", "old-thread")).rejects.toThrow(/只能使用 account-c/);
    } finally {
      pool.stop();
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
