import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {EventEmitter} from "node:events";
import {describe,it,expect} from "vitest";
import type {AccountPoolBridge} from "./accountPoolBridge.js";
import {ComposerPredictions,parsePrediction,predictionOverrides} from "./composerPredictions.js";

function setup(account="100001",enabled=true,model="gpt-6.1-sol") {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"composer-prediction-"));
 fs.writeFileSync(path.join(dir,"auth.json"),JSON.stringify({tokens:{access_token:"fixture-not-real",account_id:account}}));
 const calls:Array<{source:string;method:string;params:any}>=[];
 const pool=new EventEmitter() as any;
 pool.modelCatalogTargets=()=>[{id:account,codexHome:dir}];pool.resolveThreadAccount=async()=>({id:account});
 pool.requestOnThreadAccount=async(source:string,method:string,params:any)=>{
  calls.push({source,method,params});
  if(method==="thread/loaded/list")return {data:["source"]};
  if(method==="thread/resume")return {model,modelProvider:"openai",reasoningEffort:"medium",thread:{cwd:dir,status:{type:"idle"}}};
  if(method==="config/read")return {config:{mcp_servers:{codex_web:{command:"dummy"}}}};
  if(method==="thread/fork")return {thread:{id:"private-prediction"}};
  if(method==="turn/start") {
   pool.emit("notification",{method:"turn/started",params:{threadId:"private-prediction",turn:{id:"pred-turn"}}});
   pool.emit("notification",{method:"item/completed",params:{threadId:"private-prediction",item:{type:"agentMessage",text:JSON.stringify({suggestion:"请检查刚才修改的边界情况。"})}}});
   pool.emit("notification",{method:"turn/completed",params:{threadId:"private-prediction",turn:{id:"pred-turn",status:"completed"}}});
   return {turn:{id:"pred-turn"}};
  }
  return {};
 };
 const fetcher=async()=>new Response(JSON.stringify({is_enabled:enabled,prompt:"Predict the next message",prompt_version:"5",prediction_reasoning_effort:"high",unsupported_models:["gpt-6-sol"]}));
 return {dir,calls,pool,service:new ComposerPredictions(pool as AccountPoolBridge,fetcher as typeof fetch)};
}
describe("native App-style composer predictions",()=>{
 it("strictly parses nullable suggestions without rendering JSON",()=>{
  expect(parsePrediction('{"suggestion":" 验证一下。 "}')).toBe("验证一下。");
  for(const s of ['{"suggestion":null}','```json\n{}\n```','{"suggestion":"x","secret":"bad"}'])expect(parsePrediction(s)).toBeNull();
 });
 for(const account of ["100001","100002","100003"])it(`pins prediction to ${account}, uses an ephemeral fork and never alters credentials`,async()=>{
  const f=setup(account);const before=fs.readFileSync(path.join(f.dir,"auth.json"),"utf8");
  try {
   const result=await f.service.request("qa-user","source","turn",new AbortController().signal);
   expect(result.text).toBe("请检查刚才修改的边界情况。");
   expect(f.calls.every(c=>c.source==="source")).toBe(true);
   expect(f.calls.find(c=>c.method==="thread/fork")?.params).toMatchObject({ephemeral:true,excludeTurns:true,threadSource:"composer_predictions",permissions:":read-only",runtimeWorkspaceRoots:[],config:predictionOverrides});
   expect(f.calls.find(c=>c.method==="thread/fork")?.params.config["mcp_servers.codex_web.enabled"]).toBe(false);
   expect(f.calls.find(c=>c.method==="turn/start")?.params.turnTrigger).toBe("composer_predictions");
   expect(f.calls.at(-1)?.method).toBe("thread/unsubscribe");
   expect(fs.readFileSync(path.join(f.dir,"auth.json"),"utf8")).toBe(before);
   const count=f.calls.length;expect((await f.service.request("qa-user","source","turn",new AbortController().signal)).text).toBe(result.text);expect(f.calls.length).toBe(count);
   expect(f.pool.listenerCount("notification")).toBe(0);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
 it("does not generate on ineligible accounts or unsupported models",async()=>{
  for(const f of [setup("100001",false),setup("100001",true,"gpt-6-sol")])try {
   expect((await f.service.request("qa-user","source","turn",new AbortController().signal)).text).toBeNull();
   expect(f.calls.some(c=>c.method==="thread/fork"||c.method==="turn/start")).toBe(false);
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
 it("cancels an outstanding prediction and unsubscribes without interrupting the parent",async()=>{
  const f=setup(),abort=new AbortController();
  const original=f.pool.requestOnThreadAccount;
  f.pool.requestOnThreadAccount=async(source:string,method:string,params:any)=>{
   if(method==="turn/start") {
    f.calls.push({source,method,params});
    f.pool.emit("notification",{method:"turn/started",params:{threadId:"private-prediction",turn:{id:"pred-turn"}}});
    abort.abort();return {turn:{id:"pred-turn"}};
   }
   return original(source,method,params);
  };
  try {
   expect((await f.service.request("qa-user","source","turn",abort.signal)).text).toBeNull();
   expect(f.calls.filter(c=>c.method==="turn/interrupt").every(c=>c.params.threadId==="private-prediction")).toBe(true);
   expect(f.calls.at(-1)?.method).toBe("thread/unsubscribe");
  }finally{fs.rmSync(f.dir,{recursive:true,force:true});}
 });
});
