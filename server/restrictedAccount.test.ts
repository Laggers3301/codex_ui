import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountPoolBridge } from "./accountPoolBridge.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { allowedAccountForUser, assertTrackedUserQuotaAvailable,assertTrackedDailyQuotaWithinLimit,withCurrentTrackedQuotaPolicy,type PublicTrackedQuotaUsage } from "./routes.js";
import {serverConfig} from "./config.js";

// Public installs deliberately have no real user selected by default.
let originalTrackedUser = serverConfig.trackedQuotaUser;
let originalEnforcement = serverConfig.trackedQuotaEnforce;
beforeEach(() => {
  originalTrackedUser = serverConfig.trackedQuotaUser;
  originalEnforcement = serverConfig.trackedQuotaEnforce;
  serverConfig.trackedQuotaUser = "sample-user";
  serverConfig.trackedQuotaEnforce = false;
});
afterEach(() => {
  serverConfig.trackedQuotaUser = originalTrackedUser;
  serverConfig.trackedQuotaEnforce = originalEnforcement;
});

describe("sample-user dedicated account policy", () => {
  it("allows 100003 regardless of the old 50% cap and rejects another account's thread", async () => {
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
  it("restores the total daily cap without pinning sample-user to any account or bypassing it",()=>{
    const previous=serverConfig.trackedQuotaEnforce, previousAccount=serverConfig.trackedQuotaAllowedAccountId;
    serverConfig.trackedQuotaEnforce=true;serverConfig.trackedQuotaAllowedAccountId="";
    try {
      expect(allowedAccountForUser("sample-user")).toBeNull();
      expect(allowedAccountForUser("SAMPLE-USER")).toBeNull();
      expect(allowedAccountForUser("qa-user")).toBeNull();
      const usage={userId:"sample-user",todayQuotaPercent:49.99,dailyLimitPercent:50,blocked:false,accounts:[]} as unknown as PublicTrackedQuotaUsage;
      expect(withCurrentTrackedQuotaPolicy(usage)).toMatchObject({dailyLimitEnforced:true,blocked:false,unlimitedAccountId:null});
      const combined={...usage,todayQuotaPercent:[20,15,10,5].reduce((a,b)=>a+b,0)};
      expect(withCurrentTrackedQuotaPolicy(combined)).toMatchObject({dailyLimitEnforced:true,blocked:true});
      expect(()=>assertTrackedDailyQuotaWithinLimit(combined)).toThrow(/每日 50.00%/);
      expect(usage.blocked).toBe(false);
    }finally{serverConfig.trackedQuotaEnforce=previous;serverConfig.trackedQuotaAllowedAccountId=previousAccount;}
  });
  it.each([NaN,Infinity,-1])("fails closed when daily accounting is invalid: %s",todayQuotaPercent=>{
    expect(()=>assertTrackedDailyQuotaWithinLimit({userId:"sample-user",todayQuotaPercent,dailyLimitPercent:50})).toThrow(/暂时无法核实/);
  });
  it("recomputes cached blocked flags after changing policy rather than resetting usage",()=>{
    const previous=serverConfig.trackedQuotaEnforce, previousAccount=serverConfig.trackedQuotaAllowedAccountId;
    serverConfig.trackedQuotaAllowedAccountId="";
    try {
      const usage={userId:"sample-user",todayQuotaPercent:51.25,dailyLimitPercent:50,blocked:false} as PublicTrackedQuotaUsage;
      serverConfig.trackedQuotaEnforce=true;
      expect(withCurrentTrackedQuotaPolicy(usage)).toMatchObject({blocked:true,dailyLimitEnforced:true,todayQuotaPercent:51.25});
      serverConfig.trackedQuotaEnforce=false;
      expect(withCurrentTrackedQuotaPolicy({...usage,blocked:true})).toMatchObject({blocked:false,dailyLimitEnforced:false,todayQuotaPercent:51.25});
    }finally{serverConfig.trackedQuotaEnforce=previous;serverConfig.trackedQuotaAllowedAccountId=previousAccount;}
  });
});
