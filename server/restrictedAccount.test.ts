import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.js")>();
  return { ...original, serverConfig: { ...original.serverConfig, trackedQuotaUser: "sample-user", trackedQuotaAllowedAccountId: "sample-1234" } };
});
import { AccountPoolBridge } from "./accountPoolBridge.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { allowedAccountForUser, assertTrackedUserQuotaAvailable } from "./routes.js";

describe("dedicated account policy", () => {
  it("allows the configured account regardless of the old 50% cap and rejects another account's thread", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-restricted-account-"));
    const oldHome = path.join(temporary, "old");
    const allowedHome = path.join(temporary, "allowed");
    fs.mkdirSync(oldHome);
    fs.mkdirSync(allowedHome);
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const pool = new AccountPoolBridge({
      accounts: [
        { id: "sample-5678", label: "sample-5678", codexHome: oldHome },
        { id: "sample-1234", label: "sample-1234", codexHome: allowedHome }
      ],
      stateFile: "pool-state.json"
    }, temporary, () => Object.assign(new EventEmitter(), { stop() {} }) as unknown as CodexBridge);
    try {
      expect(allowedAccountForUser("SAMPLE-USER")).toBe("sample-1234");
      expect(allowedAccountForUser("another-user")).toBeNull();
      pool.assignThreadsToAccount(["old-thread"], "sample-5678");
      pool.assignThreadsToAccount(["allowed-thread"], "sample-1234");
      await expect(assertTrackedUserQuotaAvailable(pool as unknown as CodexBridge, store, "sample-user", "allowed-thread")).resolves.toBeUndefined();
      await expect(assertTrackedUserQuotaAvailable(pool as unknown as CodexBridge, store, "sample-user", "old-thread")).rejects.toThrow(/只能使用 sample-1234/);
    } finally {
      pool.stop();
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
