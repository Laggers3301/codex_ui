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
import {CodexBridge as NativeCodexBridge} from './codexBridge.js';
import { readThreadFromJsonl } from "./threadFallback.js";
import { createInterface } from "node:readline";
import {prepareMigratedContext} from './claudeContextPreparation.js';
import {execFile as runFile} from 'node:child_process';
import {promisify} from 'node:util';

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
  it.skipIf(!process.env.TRANSFER_NATIVE_CODEX)('round-trips through a real isolated Codex app-server and Claude filesystem SDK without model requests',async()=>{
    const f=fixture(),nativeHome=path.join(f.home,'native-codex');fs.mkdirSync(nativeHome);
    const native=new NativeCodexBridge({command:process.env.TRANSFER_NATIVE_CODEX!,args:['app-server','--listen','stdio://'],env:{HOME:f.home,CODEX_HOME:nativeHome,PATH:process.env.PATH}});
    try{
      await native.start();f.request.mockImplementation(async(method,p)=>await native.request(method,p) as any);
      const first=await f.migrate();
      const meta=await native.request('thread/read',{threadId:first.threadId,includeTurns:false}) as any;
      const rollout=meta.thread.path;expect(typeof rollout).toBe('string');paths.set(first.threadId,rollout);
      const page=await readThreadFromJsonl(rollout,first.threadId,nativeHome);expect(JSON.stringify(page.thread.turns)).toContain('TRANSFER-5520');
      await native.request('thread/resume',{threadId:first.threadId,excludeTurns:true});
      const second=await f.migrate(first.threadId,'reclaude-sonnet@1');
      const row=f.service.storage.get(second.threadId)!;
      const sdk=new URL('../integrations/claude-session-tools/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',import.meta.url).href;
      const actual=await promisify(runFile)(process.execPath,['--input-type=module','-e',`import{getSessionMessages}from ${JSON.stringify(sdk)};const rows=await getSessionMessages(${JSON.stringify(row.nativeSessionId)},{dir:${JSON.stringify(row.cwd)}});console.log(JSON.stringify(rows));`],{env:{...process.env,CLAUDE_CONFIG_DIR:row.configRoot},timeout:15000,maxBuffer:65536});
      expect(actual.stdout).toContain('TRANSFER-5520');
      const portable=f.service.storage.db.prepare('SELECT body FROM runtime_transfer_items WHERE transfer_id=? ORDER BY seq').all(second.operationId).map(r=>JSON.parse(String(r.body)));
      expect(portable.filter(m=>m.text.includes('TRANSFER-5520'))).toHaveLength(first.messageCount);
      const additions=portable.filter(m=>!m.text.includes('TRANSFER-5520'));
      expect(additions.every(m=>m.role==='user'&&m.text.includes('<environment_context>'))).toBe(true);
      console.log(JSON.stringify({nativeRoundTrip:true,sourceMessages:first.messageCount,preservedMessages:portable.length-additions.length,nativeEnvironmentMessages:additions.length,modelRequests:0,productionWrites:0}));
      expect(f.request.mock.calls.some(([method])=>method==='turn/start')).toBe(false);
    }finally{await native.stopAndWait();}
  },30000);
  it('branches a large Claude turn using only owned checkpoint metadata',async()=>{
    const f=fixture(),rows=fs.readFileSync(f.file,'utf8').trim().split('\n').map(l=>JSON.parse(l));
    f.service.storage.saveTurn(f.id,{id:'large-selected',status:'completed',nativeMessageId:rows[1].uuid,nativeSessionId:f.native,items:[{id:'large-output',type:'dynamicToolCall',output:'x'.repeat(9*1024*1024)}]});
    const read=vi.spyOn(f.service.storage,'turn');
    const input={operationId:randomUUID(),sourceThreadId:f.id,userId:'admin',projectId:f.project.id,targetModel:'gpt-6.1-sol',sourceTurnId:'large-selected'};
    const child=await f.transfers.migrate(input) as any;expect(child.messageCount).toBe(2);expect(read).not.toHaveBeenCalled();
    const other=randomUUID();f.service.storage.saveTurn(other,{id:'foreign-checkpoint',nativeMessageId:rows[1].uuid,nativeSessionId:f.native,items:[]});
    const calls=f.request.mock.calls.length;
    await expect(f.transfers.migrate({...input,operationId:randomUUID(),sourceTurnId:'foreign-checkpoint'})).rejects.toMatchObject({code:'migration_cutoff_missing'});
    expect(f.request.mock.calls).toHaveLength(calls);
  });
  it('restores full history after a Claude model-input handoff in a round trip, without importing its synthetic seed',async()=>{
    const f=fixture(),codex=await f.migrate(),file=paths.get(codex.threadId)!;
    fs.appendFileSync(file,[...Array.from({length:20},(_,i)=>({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:`ORIGINAL-${i}:`+'x'.repeat(18000)}]}}))].map(r=>JSON.stringify(r)).join('\n')+'\n');
    f.store.setThreadExecutionSettings(codex.threadId,'admin','workspace-write','on-request');
    const child=await f.migrate(codex.threadId,'reclaude-sonnet@1'),row=f.service.storage.get(child.threadId)!;
    const full=locateClaudeHistory(row.nativeSessionId,[row.configRoot])!,original=fs.readFileSync(full);
    await prepareMigratedContext(f.service.storage,row);expect(row.contextHandoff).toBeTruthy();
    const current=locateClaudeHistory(row.nativeSessionId,[row.configRoot])!,seed=JSON.parse(fs.readFileSync(current,'utf8').trim());
    const uuid=randomUUID();fs.appendFileSync(current,JSON.stringify({type:'assistant',uuid,parentUuid:seed.uuid,sessionId:row.nativeSessionId,message:{role:'assistant',content:[{type:'text',text:'NEW-CLAUDE-CONTINUATION'}]}})+'\n');
    f.service.storage.saveTurn(row.id,{id:'continued',status:'completed',nativeMessageId:uuid,nativeSessionId:row.nativeSessionId,items:[]});
    const before=fs.readFileSync(current),input={operationId:randomUUID(),sourceThreadId:row.id,userId:'admin',projectId:f.project.id,targetModel:'gpt-6.1-terra',targetReasoningEffort:'high' as const,sourceTurnId:'continued'};
    const back=await f.transfers.migrate(input) as any,text=fs.readFileSync(paths.get(back.threadId)!,'utf8');
    expect(back.messageCount).toBe(23);for(let i=0;i<20;i++)expect(text).toContain(`ORIGINAL-${i}:`);
    expect(text).toContain('NEW-CLAUDE-CONTINUATION');expect(text).not.toContain(seed.message.content[0].text.slice(0,50));
    const display=await readThreadFromJsonl(paths.get(back.threadId)!,back.threadId,f.home);expect(JSON.stringify(display.thread.turns)).toContain('NEW-CLAUDE-CONTINUATION');
    expect(f.store.getThreadOwner(back.threadId)).toMatchObject({modelOverride:'gpt-6.1-terra',reasoningEffortOverride:'high'});
    expect(f.store.getThreadExecutionSettings(back.threadId,'admin')).toMatchObject({sandbox:'workspace-write',approvalPolicy:'on-request'});
    const calls=f.request.mock.calls.length;expect((await f.transfers.migrate(input) as any).threadId).toBe(back.threadId);expect(f.request.mock.calls).toHaveLength(calls);
    const oldCheckpoint=f.service.storage.db.prepare("SELECT id FROM turns WHERE thread_id=? AND json_extract(body,'$.nativeSessionId')=? ORDER BY created_at,rowid LIMIT 1 OFFSET 1").get(row.id,row.contextHandoff!.sourceSessionId)!;
    const historical=await f.transfers.migrate({...input,operationId:randomUUID(),sourceTurnId:String(oldCheckpoint.id)}) as any;
    expect(historical.messageCount).toBe(2);expect(fs.readFileSync(paths.get(historical.threadId)!,'utf8')).not.toContain('NEW-CLAUDE-CONTINUATION');
    expect(fs.readFileSync(full)).toEqual(original);expect(fs.readFileSync(current)).toEqual(before);
    expect(f.request.mock.calls.some(([m])=>m==='turn/start')).toBe(false);
  },20000);
  it('bounds migrated model context, reuses the source compact summary and preserves complete history and cutoffs',async()=>{
    const f=fixture(),first=await f.migrate(),file=paths.get(first.threadId)!;
    const rows=[{type:'turn_context',payload:{turn_id:'kept'}},{type:'compacted',payload:{message:'COMPACT-KEEP：当前任务为物理后验校准，不重复运行旧实验。'}},
      ...Array.from({length:30},(_,i)=>({type:'response_item',payload:{type:'custom_tool_call_output',call_id:'old-'+i,output:'OLD-RESULT-'+i+'x'.repeat(18000)}})),
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'LATEST-KEEP：继续检查真实任务的执行闭环。'}]}},
      {type:'event_msg',payload:{type:'task_complete',turn_id:'kept'}},{type:'turn_context',payload:{turn_id:'future'}},{type:'compacted',payload:{message:'FUTURE-DO-NOT-INHERIT'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'FUTURE-DO-NOT-INHERIT'}]}}];
    fs.appendFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const child=await f.transfers.migrate({sourceThreadId:first.threadId,userId:'admin',projectId:f.project.id,targetModel:'reclaude-sonnet@1',sourceTurnId:'kept',operationId:randomUUID()}) as any;
    const row=f.service.storage.get(child.threadId)!,native=locateClaudeHistory(row.nativeSessionId,[row.configRoot])!;
    const original=fs.readFileSync(native),archive=f.transfers.archive(child.operationId,'admin',first.threadId)!,archiveBefore=fs.readFileSync(archive);
    const turns=f.service.storage.turnCount(row.id),used=f.service.storage.quota().used;
    await prepareMigratedContext(f.service.storage,row);
    expect(row.contextHandoff?.summaryFound).toBe(true);expect(row.contextHandoff?.bytes).toBeLessThanOrEqual(128*1024);
    expect(fs.readFileSync(row.contextHandoff!.sourceFile)).toEqual(original);expect(row.nativeSessionId).not.toBe(row.contextHandoff?.sourceSessionId);
    const working=fs.readFileSync(locateClaudeHistory(row.nativeSessionId,[row.configRoot])!,'utf8');
    expect(working).toContain('COMPACT-KEEP');expect(working).toContain('LATEST-KEEP');expect(working).not.toContain('FUTURE-DO-NOT-INHERIT');
    expect(fs.readFileSync(native)).toEqual(original);expect(fs.readFileSync(archive)).toEqual(archiveBefore);expect(f.service.storage.turnCount(row.id)).toBe(turns);
    expect(f.service.storage.quota().used).toBe(used+1);const current=row.nativeSessionId;
    const sdkPath=new URL('../integrations/claude-session-tools/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',import.meta.url).href;
    const verified=await promisify(runFile)(process.execPath,['--input-type=module','-e',`import{getSessionMessages}from ${JSON.stringify(sdkPath)};const rows=await getSessionMessages(${JSON.stringify(current)},{dir:${JSON.stringify(row.cwd)}});console.log(JSON.stringify({messages:rows.length}));`],{env:{...process.env,CLAUDE_CONFIG_DIR:row.configRoot},timeout:15000,maxBuffer:16384});
    expect(JSON.parse(verified.stdout).messages).toBe(1);
    await prepareMigratedContext(f.service.storage,row);expect(row.nativeSessionId).toBe(current);expect(f.service.storage.quota().used).toBe(used+1);
    const oldTurns=f.service.storage.turns(row.id,100),cutoff=oldTurns.at(-2)!;
    const fork=await f.service.request('thread/fork',{threadId:row.id,lastTurnId:cutoff.id}) as any;
    const forkRow=f.service.storage.get(fork.thread.id)!;expect(forkRow.contextHandoff?.rebuildFromNative).toBe(true);
    await prepareMigratedContext(f.service.storage,forkRow);
    const forkInput=fs.readFileSync(locateClaudeHistory(forkRow.nativeSessionId,[forkRow.configRoot])!,'utf8');
    expect(forkInput).not.toContain('LATEST-KEEP');expect(forkInput).not.toContain('FUTURE-DO-NOT-INHERIT');
    expect(forkRow.contextHandoff?.bytes).toBeLessThanOrEqual(128*1024);
    expect(f.request.mock.calls.some(([method])=>method==='turn/start')).toBe(false);
  },20000);
  it("renders migrated Codex tool structure from the snapshot, keeps pagination and appends only new Claude turns",async()=>{
    const f=fixture(),first=await f.migrate(),file=paths.get(first.threadId)!;
    fs.appendFileSync(file,[{type:'turn_context',payload:{turn_id:'structured-turn'}},{type:'response_item',payload:{id:'user-real',type:'message',role:'user',content:[{type:'input_text',text:'A real question'}]}},{type:'response_item',payload:{id:'tool-original',call_id:'tool-call',type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:'echo hello'})}},{type:'response_item',payload:{call_id:'tool-call',type:'function_call_output',output:[{type:'input_text',text:'hello'}]}},{type:'response_item',payload:{id:'answer-real',type:'message',role:'assistant',content:[{type:'output_text',text:'A real answer'}]}},{type:'event_msg',payload:{type:'task_complete',turn_id:'structured-turn'}}].map(v=>JSON.stringify(v)).join('\n')+'\n');
    const child=await f.migrate(first.threadId,'reclaude-sonnet@1');
    const page=await f.service.readHistory(child.threadId,0,100);
    const all=page.thread.turns.flatMap((t:any)=>t.items);
    expect(all.every((i:any)=>i.historicalImport===true)).toBe(true);
    expect(all.some((i:any)=>i.type==='toolCall')).toBe(true);expect(all.some((i:any)=>i.type==='toolCallOutput'&&i.aggregatedOutput==='hello')).toBe(true);
    expect(JSON.stringify(page.thread.turns.filter((t:any)=>t.sourceTurnId==='structured-turn'))).not.toContain('[历史工具调用');
    expect(all.filter((i:any)=>i.type==='userMessage').some((i:any)=>i.content[0].text==='A real question')).toBe(true);
    const structured=page.thread.turns.find((t:any)=>t.sourceTurnId==='structured-turn')!;
    expect(f.service.storage.turn(String(structured.id))?.nativeMessageId).toBeTruthy();
    f.service.storage.saveTurn(child.threadId,{id:'new-native-turn',status:'completed',items:[{id:'new-answer',type:'agentMessage',text:'New Claude answer'}]});
    const latest=await f.service.readHistory(child.threadId,0,100);
    expect(latest.thread.turns.map((t:any)=>t.id)).toEqual(['new-native-turn']);expect(latest.history.hasOlder).toBe(true);
    const older=await f.service.readHistory(child.threadId,latest.history.nextBefore,100);
    expect(older.thread.turns.some((t:any)=>t.items.some((i:any)=>i.id==='answer-real'))).toBe(true);
    expect(older.thread.turns.some((t:any)=>t.id==='new-native-turn')).toBe(false);
    const request=await f.service.request('thread/read',{threadId:child.threadId,includeTurns:true}) as any;
    expect(request.thread.turns.map((t:any)=>t.id)).toEqual(['new-native-turn']);
  });
  it.skipIf(!process.env.TRANSFER_BENCH_SOURCE)("replays an existing large snapshot in an isolated offline runtime",async()=>{
    const f=fixture(),source=process.env.TRANSFER_BENCH_SOURCE!;
    const fd=fs.openSync(source,'r'),header=Buffer.alloc(65536);let bytes:number;
    try{bytes=fs.readSync(fd,header);}finally{fs.closeSync(fd);}
    const id=JSON.parse(header.subarray(0,header.indexOf(10,0)).toString()).payload.id;
    paths.set(id,source);f.summaries.set(id,{id,status:{type:'idle'}});
    f.store.registerThreadOwner({threadId:id,userId:'admin',projectId:f.project.id,rootPath:f.cwd,model:'gpt-6.1-sol',reasoningEffort:'high'});
    f.store.setThreadExecutionSettings(id,'admin','danger-full-access','never');
    const phaseMs:Record<string,number>={};
    for(const method of ['snapshot','importClaude'] as const){
      const original=(f.transfers as any)[method].bind(f.transfers);
      vi.spyOn(f.transfers as any,method).mockImplementation(async(...args:unknown[])=>{const start=performance.now();try{return await original(...args);}finally{phaseMs[method]=Math.round(performance.now()-start);}});
    }
    const started=performance.now();let last=started,maxTimerLagMs=0;
    const timer=setInterval(()=>{const now=performance.now();maxTimerLagMs=Math.max(maxTimerLagMs,now-last-10);last=now;},10);
    try{
      const result=await f.migrate(id,'reclaude-sonnet@1');
      const durationMs=Math.round(performance.now()-started);clearInterval(timer);
      const actual=f.service.storage.turnCount(result.threadId);
      expect(actual).toBe(result.messageCount);expect(actual).toBeGreaterThan(10000);
      expect(f.request.mock.calls.some(([method])=>method==='turn/start')).toBe(false);
      expect(f.store.getThreadExecutionSettings(result.threadId,'admin')).toMatchObject({sandbox:'danger-full-access',approvalPolicy:'never'});
      expect(f.service.storage.db.isTransaction).toBe(false);
      const expected=f.service.storage.db.prepare('SELECT body FROM runtime_transfer_items WHERE transfer_id=? ORDER BY seq').iterate(result.operationId);
      const displayed=f.service.storage.db.prepare('SELECT body FROM turns WHERE thread_id=? ORDER BY created_at,rowid').iterate(result.threadId);
      const native=locateClaudeHistory(f.service.storage.get(result.threadId)!.nativeSessionId,[f.root])!;
      const lines=createInterface({input:fs.createReadStream(native),crlfDelay:Infinity});let checked=0,mismatches=0;
      try{for await(const line of lines){if(!line.trim())continue;const n=JSON.parse(line),e=expected.next(),d=displayed.next();if(e.done||d.done){mismatches++;break;}const message=JSON.parse(e.value.body as string),item=JSON.parse(d.value.body as string).items[0];const role=item.type==='userMessage'?'user':'assistant',text=role==='user'?item.content[0].text:item.text;if(message.role!==n.type||message.text!==n.message.content[0].text||message.role!==role||message.text!==text)mismatches++;checked++;}expect(expected.next().done).toBe(true);expect(displayed.next().done).toBe(true);}finally{lines.close();expected.return?.();displayed.return?.();}
      expect(checked).toBe(actual);expect(mismatches).toBe(0);
      console.log(JSON.stringify({benchmark:'offline-full-history',sourceBytes:fs.statSync(source).size,messageCount:actual,checked,mismatches,durationMs,phaseMs,maxTimerLagMs:Math.round(maxTimerLagMs),maxRssMiB:Math.round(process.resourceUsage().maxRSS/1024),productionWrites:0,modelRequests:0}));
    }finally{clearInterval(timer);}
  },180000);
  it("flushes pending rows before a rollback even across batch boundaries",async()=>{
    const f=fixture(),first=await f.migrate(),file=paths.get(first.threadId)!;
    const rows=[{type:'turn_context',payload:{turn_id:'discarded'}},...Array.from({length:140},(_,i)=>({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:`ROLLED-BACK-${i}`}]}})),{type:'event_msg',payload:{type:'thread_rolled_back',num_turns:1}},{type:'turn_context',payload:{turn_id:'kept'}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'FINAL-KEPT'}]}}];
    fs.appendFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const child=await f.migrate(first.threadId,'reclaude-sonnet@1');
    expect(child.messageCount).toBe(3);expect(JSON.stringify(f.service.history(child.threadId))).not.toContain('ROLLED-BACK-');
    expect(JSON.stringify(f.service.history(child.threadId))).toContain('FINAL-KEPT');
  });
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
    const presentation=JSON.stringify(await f.service.readHistory(child.threadId,0,100));
    expect(presentation).toContain('SELECTED-ANSWER');expect(presentation).not.toContain('FUTURE-MUST-NOT-IMPORT');
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
