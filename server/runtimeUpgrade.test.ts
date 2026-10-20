import {describe,it,expect} from "vitest";
import type {CodexBridge} from "./codexBridge.js";
import {runtimeIsIdle,isNewerRuntime,nextRuntimeUpgradeRetry} from "./runtimeUpgrade.js";
describe("automatic runtime update safety",()=>{
  function bridge(overrides:Record<string,unknown>={}) {
    return {getPendingServerRequests:()=>[],request:async(method:string)=> overrides[method] ?? ({
      "thread/loaded/list":{data:["t"]},"thread/read":{thread:{status:{type:"idle"}}},
      "thread/goal/get":{goal:null},"thread/queue/list":{data:[],nextCursor:null},
      "thread/backgroundTerminals/list":{data:[],nextCursor:null},
    } as Record<string,unknown>)[method]} as unknown as CodexBridge;
  }
  it("permits idle only and never downgrades or accepts alpha",async()=>{
    expect(await runtimeIsIdle(bridge())).toBe(true);
    expect(isNewerRuntime("0.162.1","0.159.2")).toBe(true);
    expect(isNewerRuntime("0.163.0-alpha.5","0.162.1")).toBe(false);
    expect(isNewerRuntime("0.159.2","0.162.1")).toBe(false);
  });
  it("defers active, unknown, queued, goal-running and terminal sessions",async()=>{
    for(const override of [
      {"thread/read":{thread:{status:{type:"active"}}}},
      {"thread/read":{thread:{status:{type:"systemError"}}}},
      {"thread/goal/get":{goal:{status:"active"}}},
      {"thread/queue/list":{data:[{id:"queued"}]}},
      {"thread/backgroundTerminals/list":{data:[{id:"terminal"}]}},
      {"thread/queue/list":{}},
    ])expect(await runtimeIsIdle(bridge(override))).toBe(false);
  });
  it("failed status reads never treat the account as idle",async()=>{
    const b=bridge();b.request=async()=>{throw new Error("offline");};
    await expect(runtimeIsIdle(b)).rejects.toThrow("offline");
  });
  it("explains long-lived terminal blockers without terminating them", async () => {
    const reasons: unknown[] = [];
    expect(await runtimeIsIdle(bridge({"thread/backgroundTerminals/list": {data:[{processId:"7"}],nextCursor:null}}), reason => reasons.push(reason))).toBe(false);
    expect(reasons).toEqual([{reason:"background_terminals_or_unknown",threadId:"t",count:1}]);
  });
  function ephemeral(overrides:Record<string,unknown>={}) {
    const b=bridge(overrides),request=b.request.bind(b);
    b.request=async(method,params,timeout)=>{
      if(method==="thread/goal/get")throw new Error("ephemeral thread does not support goals: t");
      return request(method,params,timeout);
    };
    return b;
  }
  it("accepts only the exact ephemeral-goals capability error",async()=>{
    expect(await runtimeIsIdle(ephemeral())).toBe(true);
    for(const message of ["goal read timed out","method not found","ephemeral thread does not support goals: other-thread"]) {
      const b=bridge();const request=b.request.bind(b);
      b.request=async(method,params,timeout)=>{if(method==="thread/goal/get")throw new Error(message);return request(method,params,timeout);};
      await expect(runtimeIsIdle(b)).rejects.toThrow(message);
    }
  });
  it("handles ephemeral queue capability errors but not failed durable queue reads",async()=>{
    const b=ephemeral(),request=b.request.bind(b);
    b.request=async(method,params,timeout)=>{if(method==="thread/queue/list")throw new Error("ephemeral thread does not support queued submissions: t");return request(method,params,timeout);};
    expect(await runtimeIsIdle(b)).toBe(true);
    b.request=async(method,params,timeout)=>{if(method==="thread/queue/list")throw new Error("temporary queue read error");return request(method,params,timeout);};
    await expect(runtimeIsIdle(b)).rejects.toThrow("temporary queue read error");
  });
  it("still protects queued work, terminals, active turns and approvals on ephemeral threads",async()=>{
    for(const overrides of [
      {"thread/read":{thread:{status:{type:"active"}}}},
      {"thread/queue/list":{data:[{id:"queued"}]}},
      {"thread/backgroundTerminals/list":{data:[{id:"terminal"}]}},
      {"thread/queue/list":{}},
    ])expect(await runtimeIsIdle(ephemeral(overrides))).toBe(false);
    const b=ephemeral();b.getPendingServerRequests=()=>[{}] as never;
    expect(await runtimeIsIdle(b)).toBe(false);
  });
  it("uses bounded retries rather than permanently excluding a version",()=>{
    const first=nextRuntimeUpgradeRetry(undefined,"preflight",0);
    expect(first).toEqual({attempts:1,stage:"preflight",retryAt:60000});
    expect(nextRuntimeUpgradeRetry(first,"preflight",60000).retryAt).toBe(180000);
    let retry=first;
    for(let n=0;n<20;n++)retry=nextRuntimeUpgradeRetry(retry,"preflight",0);
    expect(retry.retryAt).toBe(900000);
    expect(nextRuntimeUpgradeRetry(retry,"replacement",0)).toEqual({attempts:1,stage:"replacement",retryAt:300000});
    expect(nextRuntimeUpgradeRetry(undefined,"rollback",0).retryAt).toBe(3600000);
  });
});
