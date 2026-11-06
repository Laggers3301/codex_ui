import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "./db.js";
import { ClaudeService, getClaudeService, withClaudeService } from "./claudeService.js";
import { ClaudeRuntime } from "./claudeRuntime.js";
import type { CodexBridge } from "./codexBridge.js";
import type { ClaudeIntegrationConfig } from "./claudeBindings.js";
import { registerRoutes } from "./routes.js";
import { locateClaudeHistory } from "./claudeSessionStorage.js";
import * as claudeStorage from "./claudeSessionStorage.js";
import { gzipSync } from "node:zlib";
import * as authentication from "./auth.js";
import {resumeThreadIfUnloaded} from './scheduledTasks.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks(); });
function fixture(rateLimitInfo?: Record<string,unknown>, options: {shared?:boolean;weeklyCachePercent?:number} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-service-"));
  cleanup.push(() => fs.rmSync(home, {recursive:true,force:true}));
  const store = new ProjectStore(path.join(home,"app.sqlite")); cleanup.push(() => store.close());
  const cwd = options.shared ? path.join(home,"users","admin") : path.join(home,"workspace"); fs.mkdirSync(cwd,{recursive:true});
  const project = store.createProject({ name:"fixture", rootPath:cwd });
  const config: ClaudeIntegrationConfig = { home, executable:"/bin/true", storageDirectory:path.join(home,"state"),
    ...(options.shared ? {sharedUsers:{workspaceDirectory:path.join(home,"users"),orgIds:["1","2"]}} : {users:{admin:{workspaceRoot:cwd,orgIds:["1","2"]}}}) };
  const binding = (deviceId: string, orgId: number, uuid: string) => {
    const dir = path.join(home,`.rec/claude/accounts/${deviceId}`); fs.mkdirSync(path.join(dir,"config"),{recursive:true});
    fs.writeFileSync(path.join(dir,"device.json"),JSON.stringify({sk:"fixture-only",org_id:orgId,org_name:`org${orgId}`}));
    fs.writeFileSync(path.join(dir,"config/.claude.json"),JSON.stringify({oauthAccount:{accountUuid:uuid}}));
    return path.join(dir,"config");
  };
  const rootA = binding("11",1,"account-A"), rootB = binding("22",2,"account-B");
  if (options.weeklyCachePercent !== undefined) {
    config.usageCacheFile = path.join(home,"usage-cache.json");
    fs.writeFileSync(config.usageCacheFile,JSON.stringify({accounts:[{accountUuid:"account-A",observedAt:Date.now(),
      usage_snapshot:{seven_day:{utilization:options.weeklyCachePercent,resets_at:new Date(Date.now()+3600000).toISOString()}}}]}));
  }
  const events: any[] = [], calls: any[] = [];
  const runtimeFactory = (b: any) => new ClaudeRuntime(b, async(prompt,options) => {
    calls.push({prompt,options});
    const id = String(options.resume ?? options.extraArgs?.["session-id"]), userId = randomUUID(), messageId = randomUUID();
    const file = path.join(b.configRoot,"projects","-fixture",`${id}.jsonl`); fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.appendFileSync(file,[{type:"user",uuid:userId,parentUuid:null,sessionId:id,cwd,isSidechain:false,message:{role:"user",content:prompt}},
      {type:"assistant",uuid:messageId,parentUuid:userId,sessionId:id,cwd,isSidechain:false,message:{id:messageId,role:"assistant",content:[{type:"text",text:"完成"}]}}].map(row=>JSON.stringify(row)).join("\n")+"\n");
    return {close(){},async *[Symbol.asyncIterator]() {
      yield {type:"system",subtype:"init",session_id:id,model:"sonnet",tools:[],skills:[],mcp_servers:[]} as any;
      if(rateLimitInfo)yield {type:"rate_limit_event",rate_limit_info:rateLimitInfo,session_id:id,uuid:randomUUID()} as any;
      yield {type:"assistant",uuid:messageId,session_id:id,message:{id:messageId,role:"assistant",content:[{type:"text",text:"完成"}]}} as any;
      yield {type:"result",subtype:"success",is_error:false,result:"完成",session_id:id} as any;
    }};
  });
  const service = new ClaudeService(config,store,(type,event)=>events.push({type,...event}),runtimeFactory);
  cleanup.push(()=>service.close());
  vi.spyOn(service.bindings,"refresh").mockImplementation(async(user,model)=>service.bindings.resolve(user,model));
  const start = async () => (await service.request("thread/start",{userId:"admin",projectId:project.id,cwd,model:"reclaude-sonnet@1"}) as any).thread.id as string;
  const turn = async (threadId:string,model="reclaude-sonnet@1") => {
    const result = await service.request("turn/start",{threadId,model,input:[{type:"text",text:"检查文件"}]}) as any;
    await vi.waitFor(()=>expect(service.storage.turn(result.turn.id)?.status).toBe("completed"));
    return result.turn.id;
  };
  return {home,cwd,project,store,service,config,rootA,rootB,binding,events,calls,start,turn,runtimeFactory};
}
describe("Claude conversation switching",()=>{
  it('routes native steering without removing ordinary queued messages and persists the steered user text',async()=>{
    const f=fixture();f.service.close();let release!:()=>void,steerId='';const gate=new Promise<void>(r=>release=r),send=vi.fn(async(_content,id)=>{steerId=id;release();});let initialized=false;
    const service=new ClaudeService(f.config,f.store,()=>{},binding=>new ClaudeRuntime(binding,async(_prompt,options)=>{
      const session=String(options.resume??options.extraArgs?.['session-id']);
      return {close(){},send,async *[Symbol.asyncIterator](){
        initialized=true;yield {type:'system',subtype:'init',session_id:session,model:'sonnet',tools:[],skills:[],mcp_servers:[]} as any;
        await gate;yield {type:'assistant',uuid:randomUUID(),session_id:session,user_message_uuid:steerId,message:{id:randomUUID(),content:[{type:'text',text:'新方向回答'}]}} as any;
        yield {type:'result',subtype:'success',is_error:false,result:'新方向回答',user_message_uuids:[steerId],session_id:session} as any;
      }};
    }));cleanup.push(()=>service.close());vi.spyOn(service.bindings,'refresh').mockImplementation(async(user,model)=>service.bindings.resolve(user,model));
    const id=(await service.request('thread/start',{userId:'admin',projectId:f.project.id,cwd:f.cwd,model:'reclaude-sonnet@1'}) as any).thread.id;
    const started=await service.request('turn/start',{threadId:id,input:[{type:'text',text:'原问题'}]}) as any;await vi.waitFor(()=>expect(initialized).toBe(true));
    const queued=await service.request('thread/queue/add',{threadId:id,input:[{type:'text',text:'普通排队保留'}]}) as any;
    const steer={threadId:id,expectedTurnId:started.turn.id,clientUserMessageId:'steer-once',input:[{type:'text',text:'改方向'}]};
    await Promise.all([service.request('turn/steer',steer),service.request('turn/steer',steer)]);
    await vi.waitFor(()=>expect(service.storage.turn(started.turn.id)?.status).toBe('completed'));
    expect(send).toHaveBeenCalledOnce();expect(service.storage.queued(id)[0].id).toBe(queued.queuedSubmission.id);
    expect(JSON.stringify(service.storage.turn(started.turn.id))).toContain('改方向');
  });
  it('retains received pre-tool prose across running-history refreshes without loading tool payloads or altering native turns',async()=>{
    const f=fixture(),id=await f.start(),turnId=randomUUID();
    const original={id:turnId,status:'inProgress',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'question'}]}]};
    f.service.storage.saveTurn(id,original);
    f.store.saveTimelineItem(id,turnId,{id:'claude-message::m:1',type:'agentMessage',text:'工具前的完整说明',completed:true,timelineAt:'2026-11-06T10:00:00Z'});
    f.store.saveTimelineItem(id,turnId,{id:'tool',type:'toolCall',output:'x'.repeat(300000)});
    const first=await f.service.readHistory(id,0,100),again=await f.service.readHistory(id,0,100);
    expect(first.thread.turns[0].items).toEqual(again.thread.turns[0].items);
    expect(first.thread.turns[0].items).toContainEqual(expect.objectContaining({text:'工具前的完整说明'}));
    expect(first.thread.turns[0].items).toHaveLength(3);
    const tool=first.thread.turns[0].items.find((i:any)=>i.id==='tool');expect(tool).toMatchObject({outputDeferred:true,outputBytes:300000});expect(tool.aggregatedOutput.length).toBeLessThanOrEqual(4096);
    expect(f.service.storage.turn(turnId)).toEqual(original);
  });
  it('restores an earlier tool group beyond the 48-item live cache on every active-history reload',async()=>{
    const f=fixture(),id=await f.start(),turnId=randomUUID();
    f.service.storage.saveTurn(id,{id:turnId,status:'inProgress',items:[{id:'u',type:'userMessage',text:'query'}]});
    for(let i=0;i<99;i++)f.store.saveTimelineItem(id,turnId,{id:`claude-tool::tool-${i}`,type:'toolCall',tool:'Read',input:'{}',aggregatedOutput:'完整结果'.repeat(2000),completed:i!==98,timelineAt:new Date(Date.parse('2026-11-06T11:00:00Z')+i*1000).toISOString()});
    for(let i=0;i<2;i++){
      let page=await f.service.readHistory(id,0,20),tools:any[]=[];
      expect(page.history.nextCursor).toBeTruthy();expect(page.thread.turns[0].items.at(-1).completed).toBe(false);
      for(let pages=0;pages<10;pages++){tools.unshift(...page.thread.turns[0].items.filter((item:any)=>item.type==='toolCall'));expect(JSON.stringify(page).length).toBeLessThan(100000);if(!page.history.nextCursor)break;page=await f.service.readHistory(id,page.history.nextBefore,20,page.history.nextCursor);}
      expect(tools).toHaveLength(99);expect(new Set(tools.map(t=>t.id)).size).toBe(99);expect(tools[0].id).toBe('claude-tool::tool-0');
    }
    expect(f.store.readTimelineItem(id,'claude-tool::tool-0')?.aggregatedOutput).toBe('完整结果'.repeat(2000));
    const first=await f.service.readHistory(id,0,20);
    f.service.storage.saveTurn(id,{id:turnId,status:'completed',items:[{id:'u',type:'userMessage',text:'query'}]});
    const continued=await f.service.readHistory(id,first.history.nextBefore,20,first.history.nextCursor!);
    expect(continued.thread.turns[0].items).toHaveLength(21);
    const other=await f.start();await expect(f.service.readHistory(other,0,20,first.history.nextCursor!)).rejects.toMatchObject({code:'invalid_cursor'});
  });
  it('resumes a cold Claude queue through the shared helper and executes its input only once with saved permissions',async()=>{
    const f=fixture(),id=await f.start();
    const bridge={request:(method:string,p:unknown={})=>f.service.request(method,p as Record<string,unknown>),requestOnThreadAccount:(threadId:string,method:string,p:unknown={})=>f.service.request(method,{...(p as Record<string,unknown>),threadId})};
    expect(await resumeThreadIfUnloaded(bridge,id,f.cwd,{}, {permissions:':danger-full-access',approvalPolicy:'never'})).toBe(true);
    await bridge.request('thread/settings/update',{threadId:id,serviceTier:null});
    const queued=await bridge.request('thread/queue/add',{threadId:id,input:[{type:'text',text:'队列仅执行一次'}],clientUserMessageId:'fixture-queue-once'}) as any;
    const started=await bridge.request('thread/queue/start',{threadId:id,queuedSubmissionId:queued.queuedSubmission.id}) as any;
    await vi.waitFor(()=>expect(f.service.storage.turn(started.turn.id)?.status).toBe('completed'));
    expect(f.calls).toHaveLength(1);expect(f.calls[0].prompt).toBe('队列仅执行一次');
    expect(f.calls[0].options).toMatchObject({permissionMode:'bypassPermissions',sandbox:{enabled:false}});
    expect(await bridge.request('thread/queue/list',{threadId:id})).toMatchObject({data:[]});
    await expect(bridge.request('thread/queue/start',{threadId:id,queuedSubmissionId:queued.queuedSubmission.id})).rejects.toThrow('排队消息不存在');
    expect(f.calls).toHaveLength(1);
  });
  it('applies settings updates, exposes unsupported goal semantics and routes manual compact through the native command',async()=>{
    const f=fixture(),id=await f.start();
    await f.service.request('thread/settings/update',{threadId:id,permissions:':read-only',approvalPolicy:'never'});
    await f.service.request('thread/settings/update',{threadId:id,serviceTier:null});
    expect(await f.service.request('thread/loaded/list',{threadId:id})).toEqual({data:[]});
    expect(f.store.getThreadExecutionSettings(id,'admin')).toMatchObject({sandbox:'read-only',approvalPolicy:'never'});
    expect(await f.service.request('thread/goal/get',{threadId:id})).toMatchObject({supported:false});
    await expect(f.service.request('thread/goal/set',{threadId:id,objective:'test'})).rejects.toThrow('原生持续目标');
    const result=await f.service.request('thread/compact/start',{threadId:id}) as any;
    await vi.waitFor(()=>expect(f.service.storage.turn(result.turn.id)?.status).toBe('completed'));
    expect(f.calls.at(-1).prompt).toBe('/compact');
  });
  it('passes saved execution settings on old-session follow-ups, inherits them on forks and never overwrites manual approval',async()=>{
    const f=fixture(),id=await f.start();
    f.store.setThreadExecutionSettings(id,'admin','danger-full-access','never');
    await f.turn(id);expect(f.calls.at(-1).options).toMatchObject({permissionMode:'bypassPermissions',allowDangerouslySkipPermissions:true,sandbox:{enabled:false}});
    const branch=await f.service.request('thread/fork',{threadId:id,model:'reclaude-sonnet@1'}) as any;
    expect(f.store.getThreadExecutionSettings(branch.thread.id,'admin')).toMatchObject({sandbox:'danger-full-access',approvalPolicy:'never'});
    await f.turn(branch.thread.id);expect(f.calls.at(-1).options.permissionMode).toBe('bypassPermissions');
    f.store.setThreadExecutionSettings(id,'admin','danger-full-access','on-request');
    await f.turn(id);expect(f.calls.at(-1).options.permissionMode).toBe('default');
  });
  it("passes client-advertised effort to the native SDK and persists the selected tier",async()=>{
    const f=fixture(),binding=f.service.bindings.resolve("admin","reclaude-sonnet@1");
    const dir=path.join(f.config.storageDirectory,"model-catalog");fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,`${binding.accountKey}.json`),JSON.stringify([{value:"sonnet",resolvedModel:"claude-sonnet-5-5",displayName:"Sonnet 5.5",supportsEffort:true,supportedEffortLevels:["medium","high","max"]}]));
    const id=await f.start();
    const result=await f.service.request("turn/start",{threadId:id,model:"reclaude-sonnet@1",effort:"max",input:[{type:"text",text:"test"}]}) as any;
    await vi.waitFor(()=>expect(f.service.storage.turn(result.turn.id)?.status).toBe("completed"));
    expect(f.calls.at(-1).options.effort).toBe("max");
    f.config.organizationRedirects={"2":"1"};expect(f.service.bindings.effort("admin","reclaude-sonnet@2","max")).toBe("max");delete f.config.organizationRedirects;
    expect(f.service.summary(f.service.storage.get(id)!).configuredReasoningEffort).toBe("max");
    const count=f.calls.length;
    await expect(f.service.request("turn/start",{threadId:id,effort:"xhigh",input:[{type:"text",text:"test"}]})).rejects.toThrow(/不支持/);
    expect(f.calls).toHaveLength(count);
  });
  it("does not hash and archive the entire native history on ordinary follow-ups", async () => {
    const f = fixture(), id = await f.start();
    const stage = vi.spyOn(claudeStorage, "stageClaudeHistory");
    await f.turn(id); await f.turn(id);
    expect(stage).not.toHaveBeenCalled();
    expect(f.service.history(id).thread.turns).toHaveLength(2);
    expect(f.service.storage.get(id)?.historyArchive).toBeUndefined();
    expect(locateClaudeHistory(f.service.storage.get(id)!.nativeSessionId, [f.rootA])).toBeTruthy();
  });
  it("keeps inherited history contiguous when a page reaches its byte budget", async () => {
    const f = fixture(), parent = await f.start(), child = await f.start();
    const text = "x".repeat(2 * 1024 ** 2);
    for (let i = 0; i < 2; i++) f.service.storage.saveTurn(parent, {id:`parent-${i}`, text});
    for (let i = 0; i < 4; i++) f.service.storage.saveTurn(child, {id:`child-${i}`, text});
    const row = f.service.storage.get(child)!;
    f.service.storage.save({...row, parentThreadId:parent, inheritedTurnCount:2});
    const first = f.service.history(child);
    expect(first.thread.turns.map(turn=>turn.id)).toEqual(["child-1", "child-2", "child-3"]);
    const second = f.service.history(child, first.history.nextBefore);
    expect(second.thread.turns.map(turn=>turn.id)).toEqual(["parent-0", "parent-1", "child-0"]);
    expect(second.history.hasOlder).toBe(false);
    const page = await f.service.request("thread/turns/list", {threadId:child}) as any;
    expect(page.data.map((turn:any)=>turn.id)).toEqual(["child-3", "child-2", "child-1"]);
    const older = await f.service.request("thread/turns/list", {threadId:child, cursor:page.nextCursor}) as any;
    expect(older.data.map((turn:any)=>turn.id)).toEqual(["child-0", "parent-1", "parent-0"]);
    expect(older.nextCursor).toBeNull();
  });
  it("lazily moves every shared user's old-org conversation on the next input, including new threads with old defaults",async()=>{
    const f=fixture(undefined,{shared:true});
    const members=["alice","bob"].map(userId=>{f.store.ensureUser(userId);const cwd=path.join(f.home,"users",userId);fs.mkdirSync(cwd);return{userId,cwd,project:f.store.createProject({name:userId,rootPath:cwd,userId})};});
    const ids:string[]=[];
    for(const member of members){const result=await f.service.request("thread/start",{userId:member.userId,projectId:member.project.id,cwd:member.cwd,model:"reclaude-sonnet@1"})as any;ids.push(result.thread.id);await f.turn(result.thread.id);}
    const before=ids.map(id=>({...f.service.storage.get(id)!}));
    f.config.organizationRedirects={"1":"2"};fs.unlinkSync(path.join(path.dirname(f.rootA),"device.json"));
    for(const id of ids){await f.service.request("thread/resume",{threadId:id,model:"reclaude-sonnet@1"});await f.service.request("thread/read",{threadId:id});}
    expect(f.service.storage.quota().used).toBe(2);expect(f.calls).toHaveLength(2);
    for(let i=0;i<ids.length;i++){
      expect(f.service.storage.get(ids[i])).toEqual(before[i]);await f.turn(ids[i]);
      const after=f.service.storage.get(ids[i])!;
      expect(after).toMatchObject({id:before[i].id,userId:before[i].userId,projectId:before[i].projectId,cwd:before[i].cwd,orgId:"2",model:"reclaude-sonnet@2",parentSessionId:before[i].nativeSessionId});
      expect(after.nativeSessionId).not.toBe(before[i].nativeSessionId);
      expect(f.store.getThreadOwner(ids[i])).toMatchObject({userId:after.userId,projectId:after.projectId,modelOverride:after.model});
    }
    expect(f.service.storage.quota().used).toBe(4);await f.turn(ids[0]);expect(f.service.storage.quota().used).toBe(4);
    const fresh=await f.service.request("thread/start",{userId:members[0].userId,projectId:members[0].project.id,cwd:members[0].cwd,model:"reclaude-sonnet@1"})as any;
    expect(f.service.storage.get(fresh.thread.id)).toMatchObject({orgId:"2",model:"reclaude-sonnet@2"});
  });
  it("retains a durable prepared fork across a failure before the database mapping journal is written",async()=>{
    const f=fixture(),id=await f.start();await f.turn(id);const before={...f.service.storage.get(id)!};
    f.config.organizationRedirects={"1":"2"};
    const save=f.service.storage.beginBindingMigration.bind(f.service.storage);
    vi.spyOn(f.service.storage,"beginBindingMigration").mockImplementationOnce(()=>{throw new Error("before journal failure");}).mockImplementation(save);
    await expect(f.turn(id)).rejects.toThrow("before journal failure");
    expect(f.service.storage.get(id)).toEqual(before);expect(f.service.storage.pendingBindingMigrations()).toHaveLength(0);expect(f.service.storage.quota().used).toBe(2);
    const operation=f.service.storage.db.prepare("SELECT body FROM native_forks").get()as{body:string};const native=JSON.parse(operation.body).nativeSessionId;
    await f.turn(id);expect(f.service.storage.get(id)?.nativeSessionId).toBe(native);expect(f.service.storage.quota().used).toBe(2);expect(f.calls).toHaveLength(2);
  });
  it("checks the new shared account's weekly stop before migrating an old-org conversation",async()=>{
    const f=fixture(),id=await f.start();await f.turn(id);const before={...f.service.storage.get(id)!};f.config.organizationRedirects={"1":"2"};
    const target=f.service.bindings.resolve("admin","reclaude-sonnet@2");f.service.usage.observeResponse(target.accountKey,{rateLimitType:"seven_day",utilization:.99,resetsAt:Math.floor(Date.now()/1000)+3600});
    await expect(f.turn(id)).rejects.toMatchObject({code:"claude_weekly_limit"});expect(f.service.storage.get(id)).toEqual(before);expect(f.service.storage.quota().used).toBe(1);expect(f.calls).toHaveLength(1);
  });
  it("rediscovers history returned to ~/.claude and lazily resumes the same real account in its new device directory",async()=>{
    const f=fixture(),id=await f.start();await f.turn(id);
    const before=f.service.storage.get(id)!,owner=f.store.getThreadOwner(id);
    const legacy=path.join(f.home,".claude");fs.renameSync(f.rootA,legacy);
    const source=locateClaudeHistory(before.nativeSessionId,[legacy])!,original=fs.readFileSync(source);
    fs.writeFileSync(path.join(legacy,"settings.json"),'{"secret":"do-not-copy"}');
    const target=f.binding("33",1,"account-A");
    await f.service.request("thread/resume",{threadId:id});
    expect(f.service.storage.get(id)!.configRoot).toBe(before.configRoot);
    expect(f.calls).toHaveLength(1);
    await f.turn(id);
    const after=f.service.storage.get(id)!;
    expect(after).toMatchObject({id,userId:before.userId,projectId:before.projectId,nativeSessionId:before.nativeSessionId,configRoot:target});
    expect(f.calls[1].options.resume).toBe(before.nativeSessionId);
    expect(f.service.storage.quota().used).toBe(1);
    expect(f.store.getThreadOwner(id)).toEqual(owner);
    expect(fs.readFileSync(source)).toEqual(original);
    expect(fs.existsSync(path.join(target,"settings.json"))).toBe(false);
    expect(f.service.storage.pendingBindingMigrations()).toEqual([]);
    const lineage=f.service.storage.db.prepare("SELECT thread_id,body FROM lineage WHERE native_id=?").get(before.nativeSessionId) as any;
    expect(lineage.thread_id).toBe(id);expect(JSON.parse(lineage.body).configRoot).toBe(target);
  });
  it("recovers a crash between the main database update and native mapping commit without forking twice",async()=>{
    const f=fixture(),id=await f.start();await f.turn(id);
    const before=f.service.storage.get(id)!;
    vi.spyOn(f.service.storage,"finishBindingMigration").mockImplementationOnce(()=>{throw new Error("fixture database interruption");});
    await expect(f.service.request("thread/resume",{threadId:id,model:"reclaude-sonnet@2"})).rejects.toMatchObject({code:"claude_migration_pending"});
    expect(f.service.storage.get(id)!.nativeSessionId).toBe(before.nativeSessionId);
    expect(f.store.getThreadOwner(id)?.modelOverride).toBe("reclaude-sonnet@2");
    expect(f.service.storage.pendingBindingMigrations()).toHaveLength(1);
    expect(f.calls).toHaveLength(1);expect(f.service.storage.quota().used).toBe(2);
    f.service.close();
    const reopened=new ClaudeService(f.config,f.store,()=>{},f.runtimeFactory);cleanup.push(()=>reopened.close());
    vi.spyOn(reopened.bindings,"refresh").mockImplementation(async(user,model)=>reopened.bindings.resolve(user,model));
    const restored=reopened.storage.get(id)!;
    expect(restored.nativeSessionId).not.toBe(before.nativeSessionId);
    expect(f.store.getThreadOwner(id)).toMatchObject({userId:restored.userId,projectId:restored.projectId,rootPath:restored.cwd,modelOverride:restored.model});
    expect(reopened.storage.pendingBindingMigrations()).toEqual([]);
    const next=await reopened.request("turn/start",{threadId:id,input:[{type:"text",text:"继续"}]}) as any;
    await vi.waitFor(()=>expect(reopened.storage.turn(next.turn.id)?.status).toBe("completed"));
    expect(f.calls[1].options.resume).toBe(restored.nativeSessionId);
    expect(reopened.storage.quota().used).toBe(2);expect(reopened.history(id).thread.turns).toHaveLength(2);
  });
  it("shares the five-session budget and account weekly stop across users while retaining workspace ownership",async()=>{
    const f=fixture(undefined,{shared:true});
    const members=["alice","bob"].map(userId=>{
      f.store.ensureUser(userId);
      const cwd=path.join(f.home,"users",userId);fs.mkdirSync(cwd);
      return {userId,cwd,project:f.store.createProject({name:userId,rootPath:cwd,userId})};
    });
    const start=(member:typeof members[number])=>f.service.request("thread/start",{userId:member.userId,projectId:member.project.id,cwd:member.cwd,model:"reclaude-sonnet@1"}) as Promise<any>;
    const first=(await start(members[0])).thread.id;
    for(let i=0;i<4;i++)await start(members[i%2]);
    expect(f.service.storage.quota().used).toBe(5);
    for(const member of members) {
      expect(f.service.usageStatus(member.userId).creations).toMatchObject({used:5,remaining:0,limit:5});
      await expect(start(member)).rejects.toMatchObject({code:"claude_session_rate_limit"});
    }
    await expect(f.service.request("thread/start",{userId:"bob",projectId:members[0].project.id,cwd:members[0].cwd,model:"reclaude-sonnet@1"})).rejects.toMatchObject({code:"runtime_forbidden"});
    const outside=f.store.createProject({name:"outside",rootPath:members[0].cwd,userId:"bob"});
    await expect(f.service.request("thread/start",{userId:"bob",projectId:outside.id,cwd:outside.rootPath,model:"reclaude-sonnet@1"})).rejects.toMatchObject({code:"workspace_forbidden"});
    const key=f.service.bindings.resolve("alice","reclaude-sonnet@1").accountKey;
    f.service.usage.observeResponse(key,{rateLimitType:"seven_day",utilization:.99,resetsAt:Math.floor(Date.now()/1000)+3600});
    for(const member of members)expect(f.service.profiles(member.userId).find(p=>p.model==="reclaude-sonnet@1")?.availability).toBe("disabled");
    await expect(f.service.request("turn/start",{threadId:first,input:[{type:"text",text:"不得执行"}]})).rejects.toMatchObject({code:"claude_weekly_limit"});
    expect(f.calls).toHaveLength(0);
    expect(f.service.storage.quota().used).toBe(5);
  });
  it("finds a branch cutoff beyond a byte-limited history page without skipping turns", async () => {
    const f = fixture(), id = await f.start(), turnId = await f.turn(id);
    const original = f.service.storage.turn(turnId)!;
    const text = "x".repeat(2 * 1024 ** 2);
    for (let i = 0; i < 6; i++) f.service.storage.saveTurn(id, {...original, id:`extra-${i}`, text});
    const result = await f.service.request("thread/fork", {threadId:id, lastTurnId:turnId}) as any;
    expect(f.service.storage.get(result.thread.id)?.inheritedTurnCount).toBe(1);
    expect(f.service.history(result.thread.id).thread.turns[0].id).toBe(turnId);
  });
  it("ignores late callbacks and rejections after shutdown without invoking a queued model call", async () => {
    const f = fixture(), first = await f.start();
    await f.service.request("turn/start", {threadId:first, input:[{type:"text", text:"queued"}]});
    f.service.close(); f.service.close();
    await new Promise(resolve=>setImmediate(resolve));
    expect(f.calls).toHaveLength(0);
  });
  it("does not write a closed database when an in-flight runtime rejects or emits late events", async () => {
    const f = fixture(), id = await f.start();
    let reject!: (error:Error)=>void;
    const pending = new Promise<void>((_, fail)=>{reject=fail;});
    const run = vi.spyOn(ClaudeRuntime.prototype, "runTurn").mockImplementation(()=>pending);
    await f.service.request("turn/start", {threadId:id, input:[{type:"text", text:"pending"}]});
    await vi.waitFor(()=>expect(run).toHaveBeenCalledOnce());
    const runtime = run.mock.contexts[0] as ClaudeRuntime;
    f.service.close();
    expect(()=>{
      runtime.emit("nativeSession", {sessionId:"late"});
      runtime.emit("rateLimit", {});
      runtime.emit("serverRequest", {id:"late"});
      runtime.emit("notification", {method:"turn/completed", params:{}});
    }).not.toThrow();
    reject(new Error("late fixture failure"));
    await new Promise(resolve=>setImmediate(resolve));
    expect(f.events.some(event=>event.method==="turn/completed")).toBe(false);
  });
  it.each([
    {code:"claude_weekly_limit",kind:"seven_day",percent:.99},
    {code:"claude_five_hour_limit",kind:"five_hour",percent:1}
  ])("stops an active response at $code and rejects new calls on that account without automatic retry",async({code,kind,percent})=>{
    const f=fixture({rateLimitType:kind,utilization:percent,resetsAt:Math.floor(Date.now()/1000)+3600});
    const id=await f.start();
    const result=await f.service.request("turn/start",{threadId:id,input:[{type:"text",text:"测试阈值"}]}) as any;
    await vi.waitFor(()=>expect(f.service.storage.turn(result.turn.id)?.status).toBe("interrupted"));
    expect(f.service.storage.turn(result.turn.id)).toMatchObject({error:{code,retryable:false,source:"provider"}});
    await expect(f.start()).rejects.toMatchObject({code});
    await expect(f.service.request("turn/start",{threadId:id,input:[{type:"text",text:"不得执行"}]})).rejects.toMatchObject({code});
    expect(f.calls).toHaveLength(1);expect(f.service.storage.quota().used).toBe(1);
    expect(f.service.profiles("admin").find(p=>p.model==="reclaude-sonnet@1")?.availability).toBe("disabled");
    expect(f.service.profiles("admin").find(p=>p.model==="reclaude-sonnet@2")?.availability).toBe("ready");
    expect(f.service.usageStatus("bob").accounts).toEqual([]);
  });
  it("blocks an already accepted query when another organization on the same actual account reports weekly 99%",async()=>{
    const f=fixture({rateLimitType:"seven_day",utilization:.99,resetsAt:Math.floor(Date.now()/1000)+3600});
    f.binding("22",2,"account-A");
    const first=await f.start();
    const second=(await f.service.request("thread/start",{userId:"admin",projectId:f.project.id,cwd:f.cwd,model:"reclaude-sonnet@2"}) as any).thread.id;
    const a=await f.service.request("turn/start",{threadId:first,input:[{type:"text",text:"先返回阈值"}]}) as any;
    const b=await f.service.request("turn/start",{threadId:second,input:[{type:"text",text:"同一账号不得继续执行"}]}) as any;
    await vi.waitFor(()=>expect(f.service.storage.turn(a.turn.id)?.status).toBe("interrupted"));
    await vi.waitFor(()=>expect(f.service.storage.turn(b.turn.id)).toMatchObject({status:"failed",error:{code:"claude_weekly_limit",retryable:false}}));
    expect(f.calls).toHaveLength(1);
    expect(f.service.profiles("admin").every(profile=>profile.availability==="disabled")).toBe(true);
  });
  it("resumes after a binding directory move with no new session, and forks when the Claude account changes within that same org",async()=>{
    const f=fixture(), id=await f.start(); await f.turn(id);
    const original=f.service.storage.get(id)!.nativeSessionId;
    const moved=path.join(f.home,".rec/claude/accounts/33"); fs.renameSync(path.dirname(f.rootA),moved);
    await f.service.request("thread/resume",{threadId:id,model:"reclaude-sonnet@1"});
    expect(f.service.storage.get(id)!.nativeSessionId).toBe(original); expect(f.service.storage.quota().used).toBe(1);
    const newRoot=f.binding("33",1,"account-C");
    const source=locateClaudeHistory(original,[newRoot])!, bytes=fs.readFileSync(source);
    await f.service.request("thread/resume",{threadId:id,model:"reclaude-sonnet@1"});
    expect(f.service.storage.get(id)!.nativeSessionId).toBe(original);
    expect(f.service.storage.quota().used).toBe(1);expect(f.calls).toHaveLength(1);
    await f.turn(id);
    const changed=f.service.storage.get(id)!;
    expect(changed.nativeSessionId).not.toBe(original);expect(changed.parentSessionId).toBe(original);
    expect(f.service.storage.quota().used).toBe(2);expect(f.calls).toHaveLength(2);
    expect(fs.readFileSync(source)).toEqual(bytes);
    await f.turn(id);expect(f.calls[1].options.resume).toBe(changed.nativeSessionId);
    expect(f.service.storage.quota().used).toBe(2);
  });
  it("branches to a different organization entirely offline, inherits full UI history and resumes only the new native id",async()=>{
    const f=fixture(), id=await f.start(), first=await f.turn(id);
    const parent=f.service.storage.get(id)!;
    const refreshCalls=vi.mocked(f.service.bindings.refresh).mock.calls.length;
    const result=await f.service.request("thread/fork",{threadId:id,model:"reclaude-sonnet@2",lastTurnId:first}) as any;
    expect(vi.mocked(f.service.bindings.refresh).mock.calls).toHaveLength(refreshCalls);
    const child=f.service.storage.get(result.thread.id)!;
    expect(child.nativeSessionId).not.toBe(parent.nativeSessionId); expect(child.orgId).toBe("2");
    expect(f.calls).toHaveLength(1);
    expect(f.service.history(child.id).thread.turns[0].id).toBe(first);
    await f.turn(child.id,"reclaude-sonnet@2");
    expect(f.calls[1].options).toMatchObject({resume:child.nativeSessionId,env:{RECLAUDE_ORG:"2"}});
    expect(f.service.history(child.id).thread.turns).toHaveLength(2);
    expect(f.service.history(id).thread.turns).toHaveLength(1);
  });
  it("rejects workflow before model execution and does not count ordinary resumes twice",async()=>{
    const f=fixture(),id=await f.start();
    await expect(f.service.request("turn/start",{threadId:id,input:[{type:"text",text:"$superagent-workflow 启动"}]})).rejects.toMatchObject({code:"workflow_disabled"});
    expect(f.calls).toHaveLength(0);await f.turn(id);await f.turn(id);expect(f.service.storage.quota().used).toBe(1);
    for(let i=0;i<4;i++)await f.start();
    await expect(f.start()).rejects.toMatchObject({code:"claude_session_rate_limit"});
    await f.turn(id);expect(f.service.storage.quota().used).toBe(5);
    await expect(f.service.request("thread/resume",{threadId:id,model:"reclaude-sonnet@2"})).rejects.toMatchObject({code:"claude_session_rate_limit"});
    expect(f.service.storage.get(id)!.orgId).toBe("1");
  });
  it("rejects unauthorized projects and cross-user bindings before creating a session",async()=>{
    const f=fixture();
    await expect(f.service.request("thread/start",{userId:"bob",projectId:f.project.id,cwd:f.cwd,model:"reclaude-sonnet@1"})).rejects.toMatchObject({code:"runtime_forbidden"});
    expect(f.service.storage.quota().used).toBe(0);
    expect(f.service.bindings.profiles("bob")).toEqual([]);
  });
  it("exposes authenticated Claude models and durable paginated history through the existing HTTP routes",async()=>{
    const f=fixture();
    const base=Object.assign(new EventEmitter(),{request:vi.fn(async()=>({data:[]})),getPendingServerRequests:()=>[]}) as unknown as CodexBridge;
    const bridge=withClaudeService(base,f.store,{...f.config,storageDirectory:path.join(f.home,"routes-state")});
    const service=getClaudeService(bridge)!;cleanup.push(()=>service.close());
    vi.spyOn(service.bindings,"refresh").mockImplementation(async(user,model)=>service.bindings.resolve(user,model));
    const result=await bridge.request("thread/start",{userId:"admin",projectId:f.project.id,cwd:f.cwd,model:"reclaude-sonnet@1"}) as any;
    const id=result.thread.id;
    const largeOutput='完整工具结果'.repeat(25000),storedTurnId=randomUUID();
    service.storage.saveTurn(id,{id:storedTurnId,status:"completed",items:[{id:"message",type:"agentMessage",text:"已持久化"},
      {id:'claude-tool::large-read',type:'dynamicToolCall',tool:'Read',arguments:{file_path:'/fixture'},output:largeOutput,status:'completed'},
      {id:"claude-tool::q1",callId:"q1",type:"dynamicToolCall",tool:"request_user_input",arguments:{questions:[{id:"one",question:"选择？",options:["A","B"]}]},status:"completed"}]});
    f.store.recordQuestionAnswer(id,"q1","admin",{answers:{one:{answers:["B"]}}});
    const app=Fastify();registerRoutes(app,bridge,f.store,{backgroundIndexing:false});
    try {
      // CLI catalogue discovery must not block this menu or other providers.
      vi.spyOn(service.bindings,"refreshModels").mockImplementation(()=>new Promise<void>(()=>{}));
      const models=await app.inject({method:"GET",url:"/api/models"});expect(models.json().data.some((p:any)=>p.model==="reclaude-sonnet@1"&&p.availability==="ready")).toBe(true);
      const response=await app.inject({method:"GET",url:`/api/threads/${id}?projectId=${f.project.id}`});expect(response.statusCode).toBe(200);expect(response.json().thread.turns[0].items[0].text).toBe("已持久化");
      const preview=response.json().thread.turns[0].items.find((item:any)=>item.id==='claude-tool::large-read');
      expect(preview.outputDeferred).toBe(true);expect(preview.output.length).toBeLessThan(5000);
      const full=await app.inject({method:'GET',url:`/api/threads/${id}/items/${encodeURIComponent('claude-tool::large-read')}/output?projectId=${f.project.id}`});
      expect(full.statusCode).toBe(200);expect(full.json().data.output).toBe(largeOutput);
      expect((service.storage.turn(storedTurnId)?.items as Array<Record<string,unknown>>)[1].output).toBe(largeOutput);
      expect(response.json().thread).toMatchObject({configuredModel:"reclaude-sonnet@1",configuredReasoningEffort:"medium"});
      expect(response.json().thread.answeredQuestionItemIds).toContain("q1");
      expect(response.json().thread.questionAnswers["claude-tool::q1"]).toEqual({answers:{one:{answers:["B"]}}});
      const list=await app.inject({method:"GET",url:`/api/projects/${f.project.id}/threads`});expect(list.json().data.some((row:any)=>row.id===id)).toBe(true);
      const usage=await app.inject({method:"GET",url:"/api/reclaude/usage"});
      expect(usage.json().data).toMatchObject({thresholdPercent:99,monitoring:"response-events",creations:{used:1,remaining:4}});
      service.contextUsage.save(id,service.storage.get(id)!.nativeSessionId,{model:"claude-opus-5-5",messageId:"request",inputTokens:2,cacheReadTokens:12947,cacheWriteTokens:20044,outputTokens:244,thinkingTokens:60,contextWindow:1000000,windowSource:"runtime",at:new Date().toISOString()});
      const context=await app.inject({method:"GET",url:`/api/projects/${f.project.id}/threads/${id}/context`});
      expect(context.statusCode).toBe(200);expect(context.json().data).toMatchObject({runtime:"claude-code",usedTokens:33237,contextWindow:1000000,claudeUsage:{inputTokens:2,outputTokens:244}});
      expect((await app.inject({method:"PUT",url:`/api/projects/${f.project.id}/threads/${id}/context-config`,payload:{contextWindow:500000}})).statusCode).toBe(409);
      const auth=await app.inject({method:"GET",url:"/api/reclaude/authorization"});
      expect(auth.statusCode).toBe(200);expect(auth.headers["cache-control"]).toContain("no-store");
      expect(auth.json().data).toMatchObject({enabled:false,operation:null,organizations:expect.arrayContaining([expect.objectContaining({orgId:"1",connected:true})])});
      expect((await app.inject({method:"POST",url:"/api/reclaude/authorization/start",payload:{}})).statusCode).toBe(400);
      expect((await app.inject({method:"POST",url:"/api/reclaude/authorization/start",payload:{orgId:"999",requestId:randomUUID()}})).statusCode).toBe(403);
      expect((await app.inject({method:"POST",url:"/api/reclaude/authorization/start",headers:{"sec-fetch-site":"cross-site"},payload:{orgId:"1",requestId:randomUUID()}})).statusCode).toBe(403);
      expect((await app.inject({method:"POST",url:"/api/reclaude/authorization/cancel",payload:{id:randomUUID()}})).statusCode).toBe(403);
      const archiveFile=path.join(service.config.storageDirectory,"fixture-tools.gz"),archiveBody=gzipSync('full-native-tool-record\n');fs.writeFileSync(archiveFile,archiveBody,{mode:0o600});
      const conversation=service.storage.get(id)!;conversation.toolOutputArchive={path:archiveFile,summary:{version:1,threadId:id,sourceThreadId:id,keptRecentTurnIds:[],archivedRecords:1,archivedBytes:24,originalBranchBytes:200000000,branchBytes:1000,archiveBytes:archiveBody.length,createdAt:new Date().toISOString()}};service.storage.save(conversation);
      const attachment=await app.inject({method:"GET",url:`/api/projects/${f.project.id}/threads/${id}/tool-output-archive`});expect(attachment.statusCode).toBe(200);expect(attachment.json().data).toMatchObject({threadId:id,archivedRecords:1});expect(JSON.stringify(attachment.json())).not.toContain(archiveFile);
      const download=await app.inject({method:"GET",url:`/api/projects/${f.project.id}/threads/${id}/tool-output-archive?download=1`});expect(download.statusCode).toBe(200);expect(download.rawPayload).toEqual(archiveBody);
      f.store.ensureUser("outsider");const authUser=vi.spyOn(authentication,"authenticatedUserFromHeaders").mockReturnValue("outsider");
      try{const denied=await app.inject({method:"GET",url:`/api/projects/${f.project.id}/threads/${id}/tool-output-archive?download=1`});expect(denied.statusCode).toBe(403);
        expect((await app.inject({method:'GET',url:`/api/threads/${id}/items/claude-tool%3A%3Alarge-read/output`})).statusCode).toBe(403);
        expect((await app.inject({method:"GET",url:`/api/projects/${f.project.id}/threads/${id}/context`})).statusCode).toBe(404);
      }finally{authUser.mockRestore();}
      for(let i=0;i<4;i++)service.storage.reserve(randomUUID());
      // Pure Codex starts and forks still go to the native bridge at a full Claude quota.
      await bridge.request("thread/start",{model:"gpt-6.1-sol",cwd:f.cwd});
      await bridge.request("thread/fork",{threadId:"codex-source",model:"gpt-6.1-sol"});
      expect(service.storage.quota().used).toBe(5);
      const codexId=randomUUID();f.store.registerThreadOwner({threadId:codexId,userId:"admin",projectId:f.project.id,rootPath:f.cwd,model:"gpt-6.1-sol",reasoningEffort:"medium"});
      const target=models.json().data.find((profile:any)=>profile.model.startsWith("reclaude-"));
      const callsBeforeLimit=vi.mocked(base.request).mock.calls.length;
      const rejected=await app.inject({method:"POST",url:`/api/projects/${f.project.id}/threads/${codexId}/migrate-runtime`,payload:{operationId:randomUUID(),model:target.model}});
      expect(rejected.statusCode).toBe(429);expect(rejected.json()).toMatchObject({code:"claude_session_rate_limit",retryAfterSeconds:expect.any(Number)});
      expect(rejected.json().error).toContain("还需等待");expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(3500);
      expect(rejected.json().error).toContain("Claude 会话");expect(rejected.json().error).toContain("Codex");
      expect(vi.mocked(base.request).mock.calls).toHaveLength(callsBeforeLimit);
    } finally {await app.close();}
  });
});
