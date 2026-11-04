import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReclaudeUsageMonitor } from "./reclaudeUsage.js";
import type { ClaudeBinding } from "./claudeBindings.js";

const clean:Array<()=>void>=[];
afterEach(()=>{clean.splice(0).reverse().forEach(f=>f());});
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"reclaude-usage-"));clean.push(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,"state.sqlite"),db=new DatabaseSync(file);clean.push(()=>db.close());
  let now=Date.UTC(2026,10,2);const stop=vi.fn();
  const monitor=new ReclaudeUsageMonitor(db,stop,()=>now),key=createHash("sha256").update("actual-claude-a").digest("hex");
  const binding={accountKey:key,orgId:"1",label:"first"}as ClaudeBinding;
  return{monitor,stop,db,dir,file,key,binding,get now(){return now},advance:(ms:number)=>{now+=ms;}};
}
describe("ReClaude passive usage policy",()=>{
  it("reads all response header windows, uses fractions, and stops at exactly 99% even when 5h is the top-level limit",()=>{
    const f=fixture();
    f.monitor.observeResponse(f.key,{rate_limit_info:{rateLimitType:"five_hour",utilization:1,unifiedWindows:{seven_day:{utilization:.9899,resetsAt:(f.now+100_000)/1000}}}});
    expect(f.monitor.status(f.binding).state).toBe("available");expect(f.stop).not.toHaveBeenCalled();
    f.monitor.observeResponse(f.key,{rate_limit_info:{rateLimitType:"five_hour",utilization:.2,unifiedWindows:{seven_day:{utilization:.99,resetsAt:(f.now+100_000)/1000}}}});
    expect(f.monitor.status(f.binding)).toMatchObject({state:"disabled",retryAfterSeconds:100});
    expect(()=>f.monitor.assertAvailable({...f.binding,orgId:"different-org"})).toThrow("99%");
    expect(f.stop).toHaveBeenCalledWith(f.key,expect.stringContaining("1 分 40 秒"));
    expect(f.monitor.status({...f.binding,accountKey:"different-account"}).state).toBe("unknown");
  });
  it("retains a stop after restart, rejects stale lower usage, then expires only the upstream-reported old window",()=>{
    const f=fixture();
    f.monitor.observeResponse(f.key,{rateLimitType:"seven_day",utilization:.99,resetsAt:(f.now+60_000)/1000});
    const reopened=new ReclaudeUsageMonitor(f.db,f.stop,()=>f.now);
    reopened.observeResponse(f.key,{rateLimitType:"seven_day",utilization:.1,resetsAt:(f.now+60_000)/1000});
    expect(reopened.status(f.binding).state).toBe("disabled");
    f.advance(60_000);expect(reopened.status(f.binding).state).toBe("unknown");
    reopened.observeResponse(f.key,{rateLimitType:"seven_day",utilization:.02,resetsAt:(f.now+604800000)/1000});
    expect(reopened.status(f.binding).state).toBe("available");
  });
  it("does not interpret absent/invalid usage as zero and keeps unknown-reset stops latched",()=>{
    const f=fixture();f.monitor.observeResponse(f.key,{rateLimitType:"seven_day",utilization:null});
    expect(f.monitor.status(f.binding).state).toBe("unknown");
    f.monitor.observeResponse(f.key,{rateLimitType:"seven_day_sonnet",utilization:1.02});
    expect(f.monitor.status(f.binding).state).toBe("disabled");f.advance(20*86400000);
    expect(f.monitor.status(f.binding).state).toBe("disabled");
  });
  it("reads only a trusted local cache and matches actual Claude UUID rather than organization",()=>{
    const f=fixture(),file=path.join(f.dir,"usage-cache.json");
    fs.writeFileSync(file,JSON.stringify({accounts:[{accountUuid:"unrelated",orgId:"1",observedAt:f.now,usage_snapshot:{seven_day:{utilization:100}}}]}));
    f.monitor.readCache(file,[f.binding]);expect(f.monitor.status(f.binding).state).toBe("unknown");
    fs.writeFileSync(file,JSON.stringify({accounts:[{accountUuid:"actual-claude-a",observedAt:f.now,usage_snapshot:{seven_day:{utilization:99,resets_at:f.now+3600000}}}]}));
    f.monitor.readCache(file,[f.binding]);expect(f.monitor.status(f.binding).state).toBe("disabled");
    f.monitor.readCache(path.join(f.dir,"missing"),[f.binding]);expect(f.monitor.status(f.binding).state).toBe("disabled");expect(f.monitor.cacheError).toBeTruthy();
  });
});
