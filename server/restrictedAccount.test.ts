import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { allowedAccountForUser, assertTrackedUserQuotaAvailable,assertTrackedDailyQuotaWithinLimit } from "./routes.js";
import {serverConfig} from "./config.js";

describe("sample-user dedicated account policy", () => {
  it("allows 100003 regardless of the old 50% cap and rejects another account's thread", async () => {
    const previousUser = serverConfig.trackedQuotaUser;
    serverConfig.trackedQuotaUser = "sample-user";
    const previous=serverConfig.trackedQuotaAllowedAccountId;serverConfig.trackedQuotaAllowedAccountId="100003";
    const previousEnforce=serverConfig.trackedQuotaEnforce;serverConfig.trackedQuotaEnforce=true;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sample-user-account-"));
    const oldHome = path.join(temporary, "old");
    const allowedHome = path.join(temporary, "allowed");
    fs.mkdirSync(oldHome);
    fs.mkdirSync(allowedHome);
    const store = new ProjectStore(path.join(temporary, "store.sqlite"));
    const pool = new AccountPoolBridge({
      accounts: [
        { id: "100001", label: "100001", codexHome: oldHome },
        { id: "100003", label: "100003", codexHome: allowedHome }
      ],
      stateFile: "pool-state.json"
    }, temporary, () => Object.assign(new EventEmitter(), { stop() {} }) as unknown as CodexBridge);
    try {
      expect(allowedAccountForUser("SAMPLE-USER")).toBe("100003");
      expect(allowedAccountForUser("qa-user")).toBeNull();
      pool.assignThreadsToAccount(["old-thread"], "100001");
      pool.assignThreadsToAccount(["allowed-thread"], "100003");
      await expect(assertTrackedUserQuotaAvailable(pool as unknown as CodexBridge, store, "sample-user", "allowed-thread")).resolves.toBeUndefined();
      await expect(assertTrackedUserQuotaAvailable(pool as unknown as CodexBridge, store, "sample-user", "old-thread")).rejects.toThrow(/只能使用 100003/);
    } finally {
      serverConfig.trackedQuotaUser = previousUser;
      serverConfig.trackedQuotaAllowedAccountId=previous;
      serverConfig.trackedQuotaEnforce=previousEnforce;
      pool.stop();
      store.close();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it("retains the optional daily-cap helper independently of unrestricted default routing",()=>{
    expect(serverConfig.trackedQuotaAllowedAccountId).toBe("");
    expect(allowedAccountForUser("sample-user")).toBeNull();
    expect(allowedAccountForUser("SAMPLE-USER")).toBeNull();
    expect(()=>assertTrackedDailyQuotaWithinLimit({userId:"sample-user",todayQuotaPercent:49.99,dailyLimitPercent:50})).not.toThrow();
    for(const total of [50,51,100])expect(()=>assertTrackedDailyQuotaWithinLimit({userId:"sample-user",todayQuotaPercent:total,dailyLimitPercent:50})).toThrow(/每日 50.00%/);
    expect(()=>assertTrackedDailyQuotaWithinLimit({userId:"sample-user",todayQuotaPercent:[10,20,15,5].reduce((a,b)=>a+b,0),dailyLimitPercent:50})).toThrow();
  });
  it("does not enforce sample-user limits or touch quota services when enforcement is disabled", async () => {
    expect(serverConfig.trackedQuotaEnforce).toBe(false);
    const previous=serverConfig.trackedQuotaAllowedAccountId;
    serverConfig.trackedQuotaAllowedAccountId="100003";
    try {
      expect(allowedAccountForUser("sample-user")).toBeNull();
      expect(allowedAccountForUser("SAMPLE-USER")).toBeNull();
      const unused = new Proxy({}, {get(){throw new Error("Disabled quota enforcement accessed the bridge/store");}});
      await expect(assertTrackedUserQuotaAvailable(unused as CodexBridge, unused as ProjectStore, "sample-user", "any-account-thread")).resolves.toBeUndefined();
      await expect(assertTrackedUserQuotaAvailable(unused as CodexBridge, unused as ProjectStore, "SAMPLE-USER", "any-account-thread")).resolves.toBeUndefined();
      await expect(assertTrackedUserQuotaAvailable(unused as CodexBridge, unused as ProjectStore, "qa-user", "other-thread")).resolves.toBeUndefined();
    } finally {serverConfig.trackedQuotaAllowedAccountId=previous;}
  });
});
