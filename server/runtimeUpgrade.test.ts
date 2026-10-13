import {describe,it,expect} from "vitest";
import type {CodexBridge} from "./codexBridge.js";
import {runtimeIsIdle,isNewerRuntime} from "./runtimeUpgrade.js";
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
});
