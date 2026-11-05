import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach,describe,expect,it,vi } from "vitest";
import { ProjectStore } from "./db.js";
import { ClaudeService,offlineFork } from "./claudeService.js";
import { RuntimeHistoryTransfer,portableCodexItem,portableClaudeMessage } from "./runtimeHistoryTransfer.js";
import { locateClaudeHistory } from "./claudeSessionStorage.js";
import type { CodexBridge } from "./codexBridge.js";
import { readThreadFromJsonl } from "./threadFallback.js";

const paths=vi.hoisted(()=>new Map<string,string>());
vi.mock("./threadFallback.js",async(importOriginal)=>({...await importOriginal<typeof import("./threadFallback.js")>(),findThreadJsonlPathById:async(id:string)=>paths.get(id)??null}));
const cleanup:Array<()=>void>=[];
afterEach(()=>{cleanup.splice(0).reverse().forEach(f=>f());paths.clear();vi.restoreAllMocks();});
function fixture(){
  const home=fs.mkdtempSync(path.join(os.tmpdir(),"runtime-transfer-"));cleanup.push(()=>fs.rmSync(home,{recursive:true,force:true}));
  const cwd=path.join(home,"work");fs.mkdirSync(cwd);
  const store=new ProjectStore(path.join(home,"app.sqlite"));cleanup.push(()=>store.close());
  const project=store.createProject({name:"transfer",rootPath:cwd});
  const root=path.join(home,".rec/claude/accounts/11/config");fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(path.dirname(root),"device.json"),JSON.stringify({sk:"fixture",org_id:1,org_name:"fixture"}));
  fs.writeFileSync(path.join(root,".claude.json"),JSON.stringify({oauthAccount:{accountUuid:"claude-account-a"}}));
  const service=new ClaudeService({home,executable:"/bin/true",storageDirectory:path.join(home,"state"),users:{admin:{workspaceRoot:cwd,orgIds:["1"]}}},store,()=>{});
  cleanup.push(()=>service.close());
  const summaries=new Map<string,any>();
  const request=vi.fn(async(method:string,p:any)=>{
    if(method==="thread/start"){
      const id=randomUUID(),file=path.join(home,`${id}.jsonl`);paths.set(id,file);
      fs.writeFileSync(file,JSON.stringify({type:"session_meta",payload:{id,cwd}})+"\n");
      const thread={id,name:"imported",status:{type:"idle"}};summaries.set(id,thread);return{thread};
    }
    if(method==="thread/inject_items"){
      fs.appendFileSync(paths.get(p.threadId)!,p.items.map((payload:any)=>JSON.stringify({type:"response_item",payload})).join("\n")+"\n");return{};
    }
    if(method==="thread/read")return{thread:summaries.get(p.threadId)};
    if(method==="thread/name/set")return{};
    throw new Error(`Unexpected RPC ${method}`);
  });
  const bridge=Object.assign(new EventEmitter(),{request})as unknown as CodexBridge;
  const transfers=new RuntimeHistoryTransfer(service,bridge,store);
  const id=randomUUID(),native=randomUUID(),a=randomUUID(),b=randomUUID();
  const file=path.join(root,"projects","-fixture",`${native}.jsonl`);fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,[{type:"user",uuid:a,parentUuid:null,sessionId:native,cwd,message:{role:"user",content:"记住 TRANSFER-5520"}},
    {type:"assistant",uuid:b,parentUuid:a,sessionId:native,cwd,message:{role:"assistant",content:[{type:"text",text:"已记录 TRANSFER-5520"},{type:"tool_use",id:"t1",name:"Bash",input:{command:"echo old"}}]}}].map(row=>JSON.stringify(row)).join("\n")+"\n");
  const binding=service.bindings.resolve("admin","reclaude-sonnet@1");
  service.storage.save({id,nativeSessionId:native,userId:"admin",projectId:project.id,cwd,name:"source",model:"reclaude-sonnet@1",orgId:"1",accountKey:binding.accountKey,configRoot:root,initialized:true,archived:false,createdAt:1,updatedAt:1});
  store.registerThreadOwner({threadId:id,userId:"admin",projectId:project.id,rootPath:cwd,model:"reclaude-sonnet@1",reasoningEffort:"medium"});
  return{home,cwd,root,store,project,service,transfers,bridge,request,id,native,file,summaries,
    migrate:(source=id,model="gpt-6.1-sol",operationId=randomUUID())=>transfers.migrate({sourceThreadId:source,userId:"admin",projectId:project.id,targetModel:model,operationId})as Promise<any>};
}
describe("bidirectional runtime history transfer",()=>{
  it("accepts native fork ancestry headers after verifying the source header without modifying history",async()=>{
    const f=fixture(),first=await f.migrate(),file=paths.get(first.threadId)!;
    const rows=fs.readFileSync(file,'utf8').trim().split('\n');
    rows.splice(1,0,JSON.stringify({type:'session_meta',payload:{id:randomUUID(),forked_from_id:randomUUID()}}),JSON.stringify({type:'session_meta',payload:{id:randomUUID()}}));
    fs.writeFileSync(file,rows.join('\n')+'\n');const before=fs.readFileSync(file);
    const child=await f.migrate(first.threadId,'reclaude-sonnet@1');
    expect(child.messageCount).toBe(2);expect(JSON.stringify(f.service.history(child.threadId))).toContain('TRANSFER-5520');
    expect(fs.readFileSync(file)).toEqual(before);expect(f.request.mock.calls.some(([m])=>m==='turn/start')).toBe(false);
  });
  it.each(['foreign','missing'])("rejects a %s source header before creating a Claude destination",async(kind)=>{
    const f=fixture(),first=await f.migrate(),file=paths.get(first.threadId)!;
    const rows=fs.readFileSync(file,'utf8').trim().split('\n');
    if(kind==='foreign')rows[0]=JSON.stringify({type:'session_meta',payload:{id:randomUUID()}});else rows.shift();
    fs.writeFileSync(file,rows.join('\n')+'\n');const before=fs.readFileSync(file),used=f.service.storage.quota().used;
    await expect(f.migrate(first.threadId,'reclaude-sonnet@1')).rejects.toMatchObject({code:'migration_identity_mismatch'});
    expect(f.service.storage.quota().used).toBe(used);expect(fs.readFileSync(file)).toEqual(before);
  });
  it("branches a Codex snapshot only through the selected turn and binds retries to that target",async()=>{
    const f=fixture();
    const first=await f.migrate();
    const source=paths.get(first.threadId)!;
    fs.appendFileSync(source,[
      {type:"turn_context",payload:{turn_id:"cutoff-a"}},
      {type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"SELECTED-ANSWER"}]}},
      {type:"turn_context",payload:{turn_id:"future-b"}},
      {type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"FUTURE-MUST-NOT-IMPORT"}]}}
    ].map(r=>JSON.stringify(r)).join("\n")+"\n");
    const before=fs.readFileSync(source),operationId=randomUUID();
    const input={operationId,sourceThreadId:first.threadId,userId:"admin",projectId:f.project.id,targetModel:"reclaude-sonnet@1",sourceTurnId:"cutoff-a"};
    const child=await f.transfers.migrate(input) as any;
    const text=JSON.stringify(f.service.history(child.threadId));
    expect(text).toContain("SELECTED-ANSWER");expect(text).not.toContain("FUTURE-MUST-NOT-IMPORT");
    expect(fs.readFileSync(source)).toEqual(before);
    await expect(f.transfers.migrate({...input,sourceTurnId:"future-b"})).rejects.toMatchObject({code:"migration_conflict"});
    await expect(f.transfers.migrate({...input,targetAccountId:"different"})).rejects.toMatchObject({code:"migration_conflict"});
    await expect(f.transfers.migrate({...input,operationId:randomUUID(),sourceTurnId:"missing"})).rejects.toMatchObject({code:"migration_cutoff_missing"});
  });
  it("branches Claude at its selected native message and preserves execution permissions",async()=>{
    const f=fixture(),rows=fs.readFileSync(f.file,"utf8").trim().split("\n").map(l=>JSON.parse(l));
    f.service.storage.saveTurn(f.id,{id:"selected-turn",status:"completed",nativeMessageId:rows[1].uuid,nativeSessionId:f.native,items:[]});
    fs.appendFileSync(f.file,JSON.stringify({type:"assistant",uuid:randomUUID(),parentUuid:rows[1].uuid,sessionId:f.native,message:{role:"assistant",content:[{type:"text",text:"FUTURE-CLAUDE"}]}})+"\n");
    f.store.setThreadExecutionSettings(f.id,"admin","read-only","never");
    const result=await f.transfers.migrate({operationId:randomUUID(),sourceThreadId:f.id,userId:"admin",projectId:f.project.id,targetModel:"gpt-6.1-sol",sourceTurnId:"selected-turn",targetReasoningEffort:"max"}) as any;
    expect(fs.readFileSync(paths.get(result.threadId)!,"utf8")).not.toContain("FUTURE-CLAUDE");
    expect(f.store.getThreadExecutionSettings(result.threadId,"admin")).toMatchObject({sandbox:"read-only",approvalPolicy:"never"});
    expect(f.request.mock.calls.some(([m])=>m==="turn/start")).toBe(false);
    expect(f.request.mock.calls.find(([m])=>m==="thread/start")?.[1].config).toMatchObject({model_reasoning_effort:"max"});
    expect(f.store.getThreadOwner(result.threadId)?.reasoningEffortOverride).toBe("max");
  });
  it("copies both directions offline and counts only a Claude destination, once per operation",async()=>{
    const f=fixture(),source=fs.readFileSync(f.file),operationId=randomUUID();
    const first=await f.migrate(f.id,"gpt-6.1-sol",operationId);
    expect(first.messageCount).toBe(2);expect(f.service.storage.quota().used).toBe(0);
    expect(f.request.mock.calls.some(([method])=>method==="turn/start")).toBe(false);
    expect(fs.readFileSync(paths.get(first.threadId)!,"utf8")).toContain("TRANSFER-5520");
    expect(fs.readFileSync(paths.get(first.threadId)!,"utf8")).toContain("历史工具调用");
    const imported = await readThreadFromJsonl(paths.get(first.threadId)!, first.threadId, f.home);
    expect(JSON.stringify(imported.thread.turns)).toContain("TRANSFER-5520");
    const calls=f.request.mock.calls.length;
    expect((await f.migrate(f.id,"gpt-6.1-sol",operationId)).threadId).toBe(first.threadId);
    expect(f.request.mock.calls).toHaveLength(calls);expect(f.service.storage.quota().used).toBe(0);
    const second=await f.migrate(first.threadId,"reclaude-sonnet@1");
    expect(f.service.storage.quota().used).toBe(1);
    const child=f.service.storage.get(second.threadId)!;
    expect(child.initialized).toBe(true);const history=locateClaudeHistory(child.nativeSessionId,[f.root])!;
    const rows=fs.readFileSync(history,"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(rows).toHaveLength(2);expect(rows[1].parentUuid).toBe(rows[0].uuid);
    expect(rows[0].message.content[0].text).toContain("TRANSFER-5520");
    expect(f.service.history(child.id).thread.turns).toHaveLength(2);
    // Validate that the real filesystem SDK recognizes the imported session.
    expect(await offlineFork(child.nativeSessionId,f.root,"import validation")).not.toBe(child.nativeSessionId);
    expect(fs.readFileSync(f.file)).toEqual(source);
    expect(fs.readFileSync(f.transfers.archive(operationId,"admin",f.id)!)).toEqual(source);
    expect(f.transfers.archive(operationId,"bob",f.id)).toBeNull();
  });
  it("allows a Codex destination with all Claude slots full and blocks only a Claude destination",async()=>{
    const f=fixture();for(let i=0;i<5;i++)f.service.storage.reserve(randomUUID());
    const codex=await f.migrate();expect(codex.threadId).toBeTruthy();expect(f.service.storage.quota().used).toBe(5);
    const calls=f.request.mock.calls.length;
    await expect(f.migrate(codex.threadId,"reclaude-sonnet@1")).rejects.toMatchObject({code:"claude_session_rate_limit",message:expect.stringContaining("Claude 会话")});
    expect(f.request.mock.calls).toHaveLength(calls);
  });
  it("reclassifies historical Codex charges while preserving their audit rows and actual Claude charges",async()=>{
    const f=fixture(),operationId=randomUUID();await f.migrate(f.id,"gpt-6.1-sol",operationId);
    // A reservation left by the earlier implementation, plus a real Claude creation.
    f.service.storage.reserve(operationId);f.service.storage.reserve(randomUUID());expect(f.service.storage.quota().used).toBe(2);
    new RuntimeHistoryTransfer(f.service,f.bridge,f.store);
    expect(f.service.storage.quota().used).toBe(1);
    expect(f.service.storage.db.prepare("SELECT runtime FROM creations WHERE session_id=?").get(operationId)).toEqual({runtime:"codex"});
    new RuntimeHistoryTransfer(f.service,f.bridge,f.store);expect(f.service.storage.quota().used).toBe(1);
  });
  it("rejects another user, a running source, and reuse of an operation id for a different target",async()=>{
    const f=fixture(),operationId=randomUUID();
    await expect(f.transfers.migrate({operationId,sourceThreadId:f.id,userId:"bob",projectId:f.project.id,targetModel:"gpt-6.1-sol"})).rejects.toMatchObject({code:"runtime_forbidden"});
    const first=await f.migrate(f.id,"gpt-6.1-sol",operationId);
    await expect(f.migrate(f.id,"gpt-6.1-terra",operationId)).rejects.toMatchObject({code:"migration_conflict"});
    f.summaries.set(first.threadId,{id:first.threadId,status:{type:"active"}});
    await expect(f.migrate(first.threadId,"reclaude-sonnet@1")).rejects.toMatchObject({code:"turn_in_progress"});
    expect(f.service.storage.quota().used).toBe(0);
  });
  it("does not replay an uncertain partial import after retry or restart",async()=>{
    const f=fixture(),operationId=randomUUID(),original=f.request.getMockImplementation()!;
    f.request.mockImplementation(async(method,p)=>{if(method==="thread/inject_items")throw new Error("RPC timeout after possible write");return original(method,p);});
    await expect(f.migrate(f.id,"gpt-6.1-sol",operationId)).rejects.toThrow("timeout");
    const calls=f.request.mock.calls.length;
    const reopened=new RuntimeHistoryTransfer(f.service,f.bridge,f.store);
    await expect(reopened.migrate({operationId,sourceThreadId:f.id,userId:"admin",projectId:f.project.id,targetModel:"gpt-6.1-sol"})).rejects.toMatchObject({code:"migration_uncertain"});
    expect(f.request.mock.calls).toHaveLength(calls);expect(f.service.storage.quota().used).toBe(0);
  });
  it("keeps private reasoning out of portable messages and preserves tool output as data",()=>{
    expect(portableCodexItem({type:"reasoning",encrypted_content:"opaque"})).toBeNull();
    expect(portableCodexItem({type:"message",role:"developer",content:[{text:"internal policy"}]})).toBeNull();
    expect(portableCodexItem({type:"custom_tool_call_output",output:"literal output"})?.text).toContain("literal output");
    expect(portableClaudeMessage({type:"assistant",message:{content:[{type:"thinking",thinking:"private"},{type:"text",text:"visible"}]}})?.text).toBe("visible");
  });
});
