import {EventEmitter} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {it,expect} from "vitest";
import {AccountPoolBridge} from "./accountPoolBridge.js";
import type {CodexBridge} from "./codexBridge.js";
function auth(home:string,refresh:string,account="same"){
 fs.writeFileSync(path.join(home,"auth.json"),JSON.stringify({auth_mode:"chatgpt",tokens:{account_id:account,refresh_token:refresh,access_token:"fixture."+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+864000})).toString("base64url")+".fixture"},last_refresh:new Date().toISOString()}),{mode:0o600});
}
class Native extends EventEmitter{
 calls:string[]=[];stops=0;busy=false;failQuota=false;failStart=false;onStop=()=>{};
 async start(){if(this.failStart)throw new Error("start failed");}
 stop(){this.stops++;}
 async stopAndWait(){this.stops++;this.onStop();}
 getPendingServerRequests(){return [];}
 async request(method:string){this.calls.push(method);if(method==="thread/loaded/list")return {data:this.busy?["t"]:[]};if(method==="thread/read")return {thread:{status:{type:"active"}}};if(method==="account/read")return {account:{type:"chatgpt"}};if(method==="account/rateLimits/read"&&this.failQuota)throw new Error("HTTP 503 timeout");return {};}
}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"auth-handover-"));
 for(const name of ["a","b","stage"])fs.mkdirSync(path.join(root,name));
 auth(path.join(root,"a"),"old-a");auth(path.join(root,"b"),"old-b","b");auth(path.join(root,"stage"),"new-a");
 const instances=new Map<string,Native[]>();const make=(home:string)=>{const n=new Native();instances.set(home,[...(instances.get(home)??[]),n]);return n as unknown as CodexBridge;};
 const pool=new AccountPoolBridge({accounts:[{id:"a",label:"a",codexHome:path.join(root,"a")},{id:"b",label:"b",codexHome:path.join(root,"b")}],stateFile:"state.json"},root,make);
 return {root,pool,stage:path.join(root,"stage"),first:instances.get(path.join(root,"a"))![0],instances,cleanup(){pool.stop();fs.rmSync(root,{recursive:true,force:true});}};
}
it("does not stop or modify a busy account; quota and usage still run",async()=>{
 const f=fixture();try{const baseline=f.pool.authorizationTarget("a").expected;f.first.busy=true;
  expect(await f.pool.installAuthorizedCredentials("a",f.stage,baseline)).toBe("busy");expect(f.first.stops).toBe(0);
  await f.pool.refreshAccountData(true);expect(f.first.calls).toContain("account/usage/read");expect(f.first.calls).toContain("account/rateLimits/read");
  expect(fs.readFileSync(path.join(f.root,"a/auth.json"),"utf8")).toContain("old-a");
 }finally{f.cleanup();}
});
it("stops the old writer before installing, reloads only that account, and verifies",async()=>{
 const f=fixture();try{const baseline=f.pool.authorizationTarget("a").expected;
  f.first.onStop=()=>expect(fs.readFileSync(path.join(f.root,"a/auth.json"),"utf8")).toContain("old-a");
  expect(await f.pool.installAuthorizedCredentials("a",f.stage,baseline)).toBe("installed");
  expect(f.first.stops).toBe(1);expect(f.instances.get(path.join(f.root,"b"))![0].stops).toBe(0);
  expect(await f.pool.verifyAuthorizedAccount("a")).toBe(true);
  expect(fs.statSync(path.join(f.root,"a/auth.json")).mode&0o777).toBe(0o600);
  expect([...f.instances.values()].flatMap(x=>x.flatMap(n=>n.calls))).not.toContain("account/logout");
 }finally{f.cleanup();}
});
it("refuses a concurrent credential change before stopping the runtime",async()=>{
 const f=fixture();try{const baseline=f.pool.authorizationTarget("a").expected;auth(path.join(f.root,"a"),"newer-authoritative");
  await expect(f.pool.installAuthorizedCredentials("a",f.stage,baseline)).rejects.toThrow("authorization_conflict");expect(f.first.stops).toBe(0);
  expect(fs.readFileSync(path.join(f.root,"a/auth.json"),"utf8")).toContain("newer-authoritative");
 }finally{f.cleanup();}
});
it("refuses a mismatched account or a symlinked staging credential",async()=>{
 const f=fixture();try{const baseline=f.pool.authorizationTarget("a").expected;auth(f.stage,"wrong","different");
  await expect(f.pool.installAuthorizedCredentials("a",f.stage,baseline)).rejects.toThrow("account_mismatch");
  fs.unlinkSync(path.join(f.stage,"auth.json"));fs.symlinkSync(path.join(f.root,"a/auth.json"),path.join(f.stage,"auth.json"));
  await expect(f.pool.installAuthorizedCredentials("a",f.stage,baseline)).rejects.toThrow();expect(f.first.stops).toBe(0);
 }finally{f.cleanup();}
});
it("a verification timeout never removes newly installed credentials",async()=>{
 const f=fixture();try{await f.pool.installAuthorizedCredentials("a",f.stage,f.pool.authorizationTarget("a").expected);
  const n=f.instances.get(path.join(f.root,"a"))!.at(-1)!;n.failQuota=true;
  expect(await f.pool.verifyAuthorizedAccount("a")).toBe(false);
  expect(fs.readFileSync(path.join(f.root,"a/auth.json"),"utf8")).toContain("new-a");
  n.failQuota=false;expect(await f.pool.verifyAuthorizedAccount("a")).toBe(true);
 }finally{f.cleanup();}
});
it("does not replace credentials after shutdown",async()=>{
 const f=fixture();try{const baseline=f.pool.authorizationTarget("a").expected;f.pool.stop();
  expect(await f.pool.installAuthorizedCredentials("a",f.stage,baseline)).toBe("busy");
  expect(fs.readFileSync(path.join(f.root,"a/auth.json"),"utf8")).toContain("old-a");
 }finally{f.cleanup();}
});
it("late old-runtime errors cannot invalidate a newly installed login",async()=>{
 const f=fixture();try{
  await f.pool.installAuthorizedCredentials("a",f.stage,f.pool.authorizationTarget("a").expected);
  f.first.emit("stderr","Your access token could not be refreshed. Please log out and sign in again.");
  f.first.emit("status",{state:"exited",code:1});
  f.first.emit("errorEvent","old failed");
  expect(JSON.parse(fs.readFileSync(path.join(f.root,"state.json"),"utf8")).authFailures).toEqual({});
  expect(await f.pool.verifyAuthorizedAccount("a")).toBe(true);
 }finally{f.cleanup();}
});
