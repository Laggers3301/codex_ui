import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntime, type ClaudeQuery, type ClaudeQueryFactory } from "./claudeRuntime.js";
import { ClaudeStreamAdapter } from "./claudeStreamAdapter.js";
import { LiveStateStore } from "./liveState.js";
import type { RpcEnvelope } from "./types.js";
import { CodexBridge } from "./codexBridge.js";
import { approvalResponse } from "../shared/approvals.js";
import {claudeBranchName} from '../shared/agentRuntime.js';
import {responseLanguageInstructions} from '../scripts/agent-response-style.mjs';

const directories: string[] = [];
afterEach(() => { for (const p of directories.splice(0)) fs.rmSync(p, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function workspace() { const p = fs.mkdtempSync(path.join(os.tmpdir(), "claude-adapter-")); directories.push(p); return p; }
const init = { type: "system", subtype: "init", session_id: "native-session", model: "sonnet", tools: ["Read", "Bash", "Skill"], skills: ["pdf"], mcp_servers: [{name: "fixture", status: "connected", secret: "not-public"}], apiKeySource: "not-public" };
const success = { type: "result", subtype: "success", is_error: false, result: "检查完成", session_id: "native-session", usage: { input_tokens: 10, output_tokens: 5 } };
const sdk = (v: unknown) => v as SDKMessage;
function query(messages: unknown[]): ClaudeQuery {
  return { async *[Symbol.asyncIterator]() { for (const m of messages) yield sdk(m); }, close: vi.fn() };
}
function fixture(factory: ClaudeQueryFactory) {
  const cwd = workspace();
  const runtime = new ClaudeRuntime({ userId: "alice", orgId: "org-1", executable: "/bin/true", workspaceRoot: cwd, verifiedModels: { "reclaude-sonnet": "sonnet" } }, factory);
  const input = { userId: "alice", threadId: "thread-a", turnId: "turn-a", cwd, prompt: "检查文件", model: "reclaude-sonnet" };
  const notifications: RpcEnvelope[] = [];
  runtime.on("notification", e => notifications.push(e));
  return {runtime, input, notifications};
}

describe("Claude runtime boundaries", () => {
  it('uses the same Chinese language policy in the system prompt and native Agent input without replacing its task',async()=>{
    const factory=vi.fn(async()=>query([init,success])),{runtime,input}=fixture(factory);await runtime.runTurn(input);
    const options=(factory.mock.calls as any)[0][1];expect(options.systemPrompt.append).toContain(responseLanguageInstructions);
    const hook=options.hooks.PreToolUse[0].hooks[1],original={prompt:'Research the engine. User explicitly requests English quotations.',description:'research',run_in_background:true};
    const updated=await hook({hook_event_name:'PreToolUse',tool_name:'Agent',tool_input:original});
    expect(updated.hookSpecificOutput.updatedInput).toMatchObject({description:'research',run_in_background:true});
    expect(updated.hookSpecificOutput.updatedInput.prompt).toBe(original.prompt+'\n\n'+responseLanguageInstructions);expect(original.prompt).not.toContain('默认回复语言');
    expect(await hook({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'echo English'}})).toEqual({});
  });
  it('does not publish child narration into the main live stream but retains its original content',()=>{
    const events:any[]=[],adapter=new ClaudeStreamAdapter('thread','turn',e=>events.push(e));
    adapter.accept({type:'stream_event',parent_tool_use_id:'toolu_child',event:{type:'message_start',message:{id:'child'}}});
    adapter.accept({type:'stream_event',parent_tool_use_id:'toolu_child',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});
    adapter.accept({type:'stream_event',parent_tool_use_id:'toolu_child',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'The Newton runs look normal.'}}});
    adapter.accept({type:'assistant',parent_tool_use_id:'toolu_child',message:{id:'child',content:[{type:'text',text:'The Newton runs look normal.'}]}});
    expect(events).toEqual([]);expect([...adapter.items.values()][0].text).toBe('The Newton runs look normal.');
    adapter.accept({type:'assistant',message:{id:'main',content:[{type:'text',text:'Newton运行正常。'}]}});
    expect(events.some(e=>e.method==='item/started'&&e.params.item.text==='')).toBe(true);
    expect(events.some(e=>e.method==='item/completed'&&e.params.item.text==='Newton运行正常。')).toBe(true);
  });
  it('keeps the current text and tool result before consuming a boundary steer, finishing once',async()=>{
    let sentId='',release!:()=>void;const gate=new Promise<void>(r=>release=r),close=vi.fn();
    const {runtime,input,notifications}=fixture(async()=>({close,send:async(_content,id)=>{sentId=id;release();},async *[Symbol.asyncIterator](){
      yield sdk(init);yield sdk({type:'assistant',message:{id:'original',content:[{type:'text',text:'原回答完整保留。'},{type:'tool_use',id:'tool1',name:'Bash',input:{command:'fixture'}}]}});
      await gate;yield sdk({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool1',content:'工具正常返回'}]}});
      yield sdk({...success,result:'原回答完整保留。',result_index:0});
      yield sdk({type:'assistant',user_message_uuid:sentId,message:{id:'new',content:[{type:'text',text:'已接入新方向。'}]}});
      yield sdk({...success,result:'已接入新方向。',user_message_uuids:[sentId],result_index:1});
    }}));
    const running=runtime.runTurn(input);await vi.waitFor(()=>expect(notifications.some(n=>n.method==='item/started'&&(n.params as any)?.item?.tool==='Bash')).toBe(true));
    await runtime.steer('alice',input.threadId,input.turnId,{prompt:'新方向',parts:[{type:'text',text:'新方向'}],clientId:'boundary-test'});await running;
    const completed=notifications.filter(n=>n.method==='turn/completed');expect(completed).toHaveLength(1);
    const turn=(completed[0].params as any).turn;expect(turn.status).toBe('completed');
    expect(turn.items.some((i:any)=>i.text==='原回答完整保留。')).toBe(true);
    expect(turn.items.some((i:any)=>i.output==='工具正常返回')).toBe(true);
    expect(turn.items.some((i:any)=>i.text==='已接入新方向。')).toBe(true);expect(close).toHaveBeenCalledOnce();
  });
  it('does not close a resumed query on an uncorrelated old zero-turn result before the new send starts',async()=>{
    const {runtime,input,notifications}=fixture(async()=>query([init,{...success,result:'',num_turns:0,stop_reason:null,result_index:0,usage:{input_tokens:0,output_tokens:0}},
      {type:'assistant',user_message_uuid:'turn-a',message:{id:'resumed',content:[{type:'text',text:'旧代理结果已汇总'}]}},{...success,result:'旧代理结果已汇总',num_turns:1,result_index:1,user_message_uuid:'turn-a'}]));
    await runtime.runTurn({...input,resumeSessionId:'old-native'});
    expect(notifications.some(n=>n.method==='runtime/claudeResumePending')).toBe(true);
    expect(notifications.filter(n=>n.method==='turn/completed')).toHaveLength(1);
    expect(notifications.at(-1)?.params).toMatchObject({turn:{status:'completed'}});
  });
  it('still reports a genuine empty result correlated to the current send',async()=>{
    const {runtime,input,notifications}=fixture(async()=>query([init,{...success,result:'',num_turns:0,stop_reason:null,user_message_uuid:'turn-a'}]));
    await runtime.runTurn({...input,resumeSessionId:'old-native'});
    expect(notifications.some(n=>n.method==='runtime/claudeResumePending')).toBe(false);
    expect(notifications.at(-1)?.params).toMatchObject({turn:{status:'failed',error:{code:'claude_empty_response'}}});
  });
  it('keeps a query alive after the parent result until background results are consumed and summarized',async()=>{
    let release!:()=>void;const gate=new Promise<void>(r=>release=r),closed=vi.fn();
    const {runtime,input,notifications}=fixture(async()=>({close:closed,async *[Symbol.asyncIterator](){
      yield sdk(init);yield sdk({type:'system',subtype:'task_started',task_id:'child',is_backgrounded:true,subagent_type:'general-purpose'});
      yield sdk({type:'assistant',message:{id:'wait',content:[{type:'text',text:'等待子代理'}]}});
      yield sdk({...success,result:'等待子代理',result_index:0});await gate;
      yield sdk({type:'system',subtype:'task_notification',task_id:'child',status:'completed'});
      yield sdk({type:'assistant',message:{id:'summary',content:[{type:'text',text:'已汇总子代理结果'}]}});yield sdk({...success,result:'已汇总子代理结果',result_index:1});
    }}));
    const running=runtime.runTurn(input);await vi.waitFor(()=>expect(notifications.some(n=>n.method==='runtime/claudeBackgroundWait')).toBe(true));
    expect(notifications.some(n=>n.method==='turn/completed')).toBe(false);expect(closed).not.toHaveBeenCalled();
    release();await running;expect(notifications.filter(n=>n.method==='turn/completed')).toHaveLength(1);expect(notifications.at(-1)?.params).toMatchObject({turn:{status:'completed'}});expect(closed).toHaveBeenCalledOnce();
  });
  it('delivers a steer exactly once, validates the expected turn and preserves the new user message',async()=>{
    let sentId='',release!:()=>void;const gate=new Promise<void>(r=>release=r),send=vi.fn(async(_content,id)=>{sentId=id;release();});
    const {runtime,input,notifications}=fixture(async()=>({close:vi.fn(),send,async *[Symbol.asyncIterator](){
      yield sdk(init);await gate;
      yield sdk({type:'result',subtype:'error_during_execution',is_error:true,terminal_reason:'aborted_streaming',result_index:0,usage:{input_tokens:2,output_tokens:1}});
      yield sdk({type:'assistant',user_message_uuid:sentId,message:{id:'steered',content:[{type:'text',text:'按新方向回答'}]}});
      yield sdk({...success,result:'按新方向回答',user_message_uuids:[sentId],result_index:1});
    }}));
    const running=runtime.runTurn(input);await vi.waitFor(()=>expect(notifications.some(n=>n.method==='runtime/initialized')).toBe(true));
    const submission={prompt:'新方向',parts:[{type:'text',text:'新方向'}],clientId:'same-request'};
    expect(()=>runtime.steer('bob',input.threadId,input.turnId,submission)).toThrow();
    expect(()=>runtime.steer('alice',input.threadId,'old-turn',submission)).toThrow();
    const first=runtime.steer('alice',input.threadId,input.turnId,submission),again=runtime.steer('alice',input.threadId,input.turnId,submission);expect(first).toBe(again);
    await first;await running;expect(send).toHaveBeenCalledOnce();
    const final=(notifications.find(n=>n.method==='turn/completed')?.params as any).turn;
    expect(final.items.filter((i:any)=>i.type==='userMessage')).toHaveLength(1);expect(final.status).toBe('completed');expect(final.usage).toMatchObject({input_tokens:12,output_tokens:6});
  });
  it('announces a native session once rather than persisting it on every stream frame',async()=>{
    const frames=[init,...Array.from({length:60},()=>({type:'stream_event',event:{type:'ping'}})),success];
    const {runtime,input}=fixture(async()=>query(frames)),sessions:unknown[]=[];
    runtime.on('nativeSession',e=>sessions.push(e));await runtime.runTurn(input);expect(sessions).toHaveLength(1);
  });
  it('passes scoped MCP and multimodal blocks through to the native query, and enforces read-only hooks',async()=>{
    const factory=vi.fn(async()=>query([init,success])),{runtime,input}=fixture(factory);
    const content=[{type:'text',text:'检查图片'},{type:'image',source:{type:'base64',media_type:'image/png',data:'eA=='}}];
    await runtime.runTurn({...input,content,mcpServers:{codex_browser:{type:'http',url:'http://127.0.0.1:4576/api/browser/mcp'}},sandbox:'read-only',approvalPolicy:'never'});
    const call=(factory.mock.calls as any)[0];expect(call[3]).toEqual(content);expect(call[1].mcpServers.codex_browser.url).toContain('/api/browser/mcp');
    const hook=call[1].hooks.PreToolUse[0].hooks[1];
    expect(await hook({hook_event_name:'PreToolUse',tool_name:'Write',tool_input:{file_path:input.cwd+'/x'} })).toMatchObject({hookSpecificOutput:{permissionDecision:'deny'}});
    expect(await hook({hook_event_name:'PreToolUse',tool_name:'Read',tool_input:{file_path:input.cwd+'/x'} })).toEqual({});
  });
  it('maps only explicit full-access never-ask to native bypass, preserving plan and manual modes',async()=>{
    const factory=vi.fn(async()=>query([init,success])),{runtime,input}=fixture(factory);
    for(const settings of [
      {sandbox:'danger-full-access',approvalPolicy:'never'},
      {sandbox:'danger-full-access',approvalPolicy:'on-request'},
      {sandbox:'read-only',approvalPolicy:'never'},
      {sandbox:'danger-full-access',approvalPolicy:'never',collaborationMode:'plan'}
    ] as const)await runtime.runTurn({...input,...settings});
    const calls=factory.mock.calls as unknown as Array<[string,Options]>;
    expect(calls.map(c=>c[1].permissionMode)).toEqual(['bypassPermissions','default','default','plan']);
    expect(calls[0][1]).toMatchObject({allowDangerouslySkipPermissions:true,sandbox:{enabled:false}});
    expect(calls[1][1].allowDangerouslySkipPermissions).toBeUndefined();
    expect(calls[3][1].allowDangerouslySkipPermissions).toBeUndefined();
  });
  it('still forwards real questions in full-access never-ask mode',async()=>{
    let answer:unknown;
    const factory:ClaudeQueryFactory=async(_,options)=>({close(){},async *[Symbol.asyncIterator](){
      yield sdk(init);
      answer=await options.canUseTool!('AskUserQuestion',{questions:[{question:'需要哪种方案？',header:'方案',options:[{label:'A',description:'方案A'},{label:'B',description:'方案B'}],multiSelect:false}]},{signal:options.abortController!.signal,toolUseID:'bypass-question'});
      yield sdk(success);
    }});
    const {runtime,input}=fixture(factory);
    runtime.on('serverRequest',request=>{expect(request.method).toBe('item/tool/requestUserInput');runtime.answerUserInput('alice',request.id,{answers:{[request.params.questions[0].id]:{answers:['B']}}});});
    await runtime.runTurn({...input,sandbox:'danger-full-access',approvalPolicy:'never'});
    expect(answer).toMatchObject({behavior:'allow',updatedInput:{answers:{'需要哪种方案？':'B'}}});
  });
  it('labels Claude branches without duplicating old account or migration suffixes',()=>{
    expect(claudeBranchName('示例项目 - 0001 · 迁移')).toBe('示例项目 - ReClaude');
    expect(claudeBranchName('示例项目 - ReClaude · 分支')).toBe('示例项目 - ReClaude');
    expect(claudeBranchName('场景-0123')).toBe('场景-0123 - ReClaude');
  });
  it("reports the latest main-model request and runtime window, not cumulative or subagent usage", async () => {
    const message = (id:string,input:number,parent:string|null=null) => ({type:"assistant",parent_tool_use_id:parent,message:{id,model:"claude-opus-5-5",content:[],usage:{input_tokens:input,cache_read_input_tokens:100,cache_creation_input_tokens:20,output_tokens:4,output_tokens_details:{thinking_tokens:2}}}});
    const factory=vi.fn(async()=>query([init,message("first",10),message("second",30),message("second",30),message("child",999999,"tool"),{...success,usage:{input_tokens:999999},modelUsage:{"claude-opus-5-5":{inputTokens:999999,contextWindow:200000}}}]));
    const {runtime,input}=fixture(factory),snapshots:any[]=[];
    runtime.on("contextUsage",snapshot=>snapshots.push(snapshot));
    const historyReader={search:vi.fn(),read:vi.fn()};
    await runtime.runTurn({...input,historyReader});
    expect(snapshots.at(-1)).toMatchObject({messageId:"second",inputTokens:30,cacheReadTokens:100,cacheWriteTokens:20,outputTokens:4,thinkingTokens:2,contextWindow:200000,windowSource:"runtime"});
    expect(snapshots.some(s=>s.messageId==="child")).toBe(false);
    expect((factory.mock.calls as any)[0][2]).toBe(historyReader);
    expect(JSON.stringify((factory.mock.calls as any)[0][1].systemPrompt)).toContain("codex_web_history");
  });

  it("does not start any process before binding, or route a Claude selection to Codex", async () => {
    const factory = vi.fn();
    await expect(new ClaudeRuntime(null, factory).runTurn({userId:"alice",threadId:"t",turnId:"r",cwd:"/tmp",prompt:"hi",model:"reclaude-sonnet"})).rejects.toMatchObject({code:"runtime_not_connected"});
    expect(factory).not.toHaveBeenCalled();
    const codex = new CodexBridge();
    const start = vi.spyOn(codex,"start").mockResolvedValue();
    await expect(codex.request("thread/start", {model:"reclaude-sonnet"})).rejects.toMatchObject({code:"runtime_not_connected"});
    await expect(codex.request("turn/start", {collaborationMode:{settings:{model:"reclaude-opus"}}})).rejects.toMatchObject({code:"runtime_not_connected"});
    expect(start).not.toHaveBeenCalled();
  });

  it("enforces owner, real workspace paths and verified models before invoking the SDK", async () => {
    const factory = vi.fn(); const {runtime,input} = fixture(factory);
    await expect(runtime.runTurn({...input,userId:"bob"})).rejects.toMatchObject({code:"runtime_forbidden"});
    await expect(runtime.runTurn({...input,model:"reclaude-opus"})).rejects.toMatchObject({code:"unsupported_model"});
    const outside = workspace(); fs.symlinkSync(outside,path.join(input.cwd,"outside"));
    await expect(runtime.runTurn({...input,cwd:path.join(input.cwd,"outside")})).rejects.toMatchObject({code:"workspace_forbidden"});
    expect(factory).not.toHaveBeenCalled();
  });

  it("retains native skills/tool configuration and resumes only the adapter's own session mapping", async () => {
    for (const key of ["OPENAI_API_KEY", "ARK_PAY_API_KEY", "MIMO_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CODEX_WEB_PRIVATE_CONFIG"]) vi.stubEnv(key, "fixture-backend-secret");
    vi.stubEnv("HTTPS_PROXY", "http://fixture-proxy:8080");
    const factory = vi.fn(async () => query([init,success])); const {runtime,input,notifications} = fixture(factory);
    await runtime.runTurn(input);
    await runtime.runTurn({...input,turnId:"turn-b"});
    const options = (factory.mock.calls as unknown as Array<[string, Options]>).map(c=>c[1]);
    expect(options[0]).toMatchObject({cwd:input.cwd,model:"sonnet",permissionMode:"default",includePartialMessages:true,settingSources:["user","project","local"],tools:{type:"preset",preset:"claude_code"},env:{RECLAUDE_ORG:"org-1"}});
    expect(options[0].resume).toBeUndefined(); expect(options[1].resume).toBe("native-session");
    expect(JSON.stringify(options[0].env)).not.toContain("fixture-backend-secret");
    expect(options[0].env?.HTTPS_PROXY).toBe("http://fixture-proxy:8080");
    expect(JSON.stringify(notifications)).not.toContain("not-public");
    expect(notifications.find(e=>e.method==="runtime/initialized")?.params).toMatchObject({skills:["pdf"],tools:["Read","Bash","Skill"]});
    expect(()=>runtime.sessionForThread("bob",input.threadId)).toThrow();
  });

  it("binds each approval to its user and original input, without granting session-wide access", async () => {
    let result: unknown;
    const factory: ClaudeQueryFactory = async (_, options) => ({close:vi.fn(),async *[Symbol.asyncIterator]() {
      yield sdk(init);
      result = await options.canUseTool!("Bash",{command:"git status"},{signal:options.abortController!.signal,toolUseID:"tool-1"});
      yield sdk(success);
    }});
    const {runtime,input} = fixture(factory);
    runtime.on("serverRequest", request => {
      expect(request.method).toBe("item/claudeTool/requestApproval");
      expect(()=>runtime.answerApproval("bob",request.id,"accept")).toThrow();
      expect(()=>runtime.answerApproval("alice",request.id,"acceptForSession")).toThrow();
      request.params.toolInput.command="altered client input";
      const answer = approvalResponse(request,{decision:"accept",updatedInput:{command:"altered"}}) as {decision:string};
      runtime.answerApproval("alice",request.id,answer.decision);
      expect(()=>runtime.answerApproval("alice",request.id,"accept")).toThrow();
    });
    await runtime.runTurn(input);
    expect(result).toEqual({behavior:"allow",updatedInput:{command:"git status"}});
  });

  it("cancels pending approvals, preserves partial text and refuses a concurrent turn", async () => {
    let denied: unknown; let pending!: () => void;
    const waiting = new Promise<void>(resolve=>{pending=resolve;});
    const factory: ClaudeQueryFactory = async (_,options) => ({close:vi.fn(),async *[Symbol.asyncIterator]() {
      yield sdk(init);
      yield sdk({type:"assistant",message:{id:"m",content:[{type:"text",text:"已读取文件"}]}});
      denied = await options.canUseTool!("Edit",{file_path:"demo.txt"},{signal:options.abortController!.signal,toolUseID:"edit-1"});
    }});
    const {runtime,input,notifications} = fixture(factory);
    runtime.on("serverRequest",pending);
    const run=runtime.runTurn(input);await waiting;
    await expect(runtime.runTurn({...input,turnId:"other"})).rejects.toMatchObject({code:"turn_in_progress"});
    runtime.interrupt("alice",input.threadId); await run;
    expect(denied).toMatchObject({behavior:"deny"});
    expect(notifications.at(-1)?.params).toMatchObject({turn:{status:"interrupted",items:[{text:"已读取文件"}]}});
  });

  it("reports truncated and failed streams as failures, never successful answers", async () => {
    for (const messages of [[init], [init,{...success,is_error:true,errors:["fixture failure"]}]]) {
      const {runtime,input,notifications}=fixture(async()=>query(messages));
      await runtime.runTurn(input);
      expect(notifications.at(-1)?.params).toMatchObject({turn:{status:"failed"}});
    }
  });

  it("sends four native questions through the user-input protocol and returns only the user's validated answers", async () => {
    const questions=Array.from({length:4},(_,index)=>({question:`问题 ${index+1}？`,header:`Q${index}`,options:[{label:"A",description:"第一项"},{label:"B",description:"第二项"}],multiSelect:index===3}));
    let result:unknown;
    const factory:ClaudeQueryFactory=async(_,options)=>({close:vi.fn(),async *[Symbol.asyncIterator](){
      yield sdk(init);
      yield sdk({type:"assistant",message:{id:"questions-message",content:[{type:"tool_use",id:"ask-1",name:"AskUserQuestion",input:{questions}}]}});
      result=await options.canUseTool!("AskUserQuestion",{questions},{signal:options.abortController!.signal,toolUseID:"ask-1"});
      yield sdk(success);
    }});
    const {runtime,input,notifications}=fixture(factory);
    runtime.on("serverRequest",request=>{
      expect(request).toMatchObject({method:"item/tool/requestUserInput",params:{itemId:"ask-1",isBlocking:true}});
      expect(request.params.questions).toHaveLength(4);
      expect(()=>runtime.answerApproval("alice",request.id,"accept")).toThrow();
      expect(()=>runtime.answerUserInput("bob",request.id,{})).toThrow();
      expect(()=>runtime.answerUserInput("alice",request.id,{answers:{}})).toThrow();
      const answers=Object.fromEntries(request.params.questions.map((question:any,index:number)=>[question.id,{answers:[index===3?"A, B":"A"]}]));
      request.params.questions[0].question="客户端不得改写的问题";
      runtime.answerUserInput("alice",request.id,{answers});
      expect(()=>runtime.answerUserInput("alice",request.id,{answers})).toThrow();
    });
    await runtime.runTurn(input);
    expect(result).toEqual({behavior:"allow",updatedInput:{questions,answers:{"问题 1？":"A","问题 2？":"A","问题 3？":"A","问题 4？":"A, B"}}});
    const tool=notifications.filter(event=>event.method==="item/started").map(event=>(event.params as any).item).find(item=>item.tool==="request_user_input");
    expect(tool).toMatchObject({callId:"ask-1",arguments:{questions:[{id:"claude:ask-1:0"},{id:"claude:ask-1:1"},{id:"claude:ask-1:2"},{id:"claude:ask-1:3",multiSelect:true}]}});
  });

  it("selects native plan mode and can turn it off explicitly on the next turn", async () => {
    const factory=vi.fn(async()=>query([init,success]));const {runtime,input}=fixture(factory);
    await runtime.runTurn({...input,collaborationMode:"plan"});
    await runtime.runTurn({...input,turnId:"execute",collaborationMode:"default"});
    const calls=factory.mock.calls as unknown as Array<[string,Options]>;
    expect(calls[0][1].permissionMode).toBe("plan");expect(calls[1][1].permissionMode).toBe("default");
  });

  it("cancels an unanswered question without granting tool permission", async()=>{
    let result:unknown;
    const factory:ClaudeQueryFactory=async(_,options)=>({close:vi.fn(),async *[Symbol.asyncIterator](){
      result=await options.canUseTool!("AskUserQuestion",{questions:[{question:"选择？",options:[{label:"A"},{label:"B"}]}]},
        {signal:options.abortController!.signal,toolUseID:"cancel-question"});
    }});
    const {runtime,input,notifications}=fixture(factory);
    runtime.on("serverRequest",()=>runtime.interrupt("alice",input.threadId));
    await runtime.runTurn(input);expect(result).toMatchObject({behavior:"deny"});
    expect(notifications.at(-1)?.params).toMatchObject({turn:{status:"interrupted"}});
  });
});

describe("Claude stream translation", () => {
  it('does not silently succeed on empty native replies and retains only safe result metadata',()=>{
    const events:RpcEnvelope[]=[];const adapter=new ClaudeStreamAdapter('t','r',e=>events.push(e));
    adapter.accept({...success,result:'',num_turns:0,stop_reason:null,secret:'never-save'});
    expect(events.at(-1)?.params).toMatchObject({turn:{status:'failed',error:{code:'claude_empty_response'},nativeResult:{resultLength:0,num_turns:0}}});
    expect(JSON.stringify(events)).not.toContain('never-save');
    const local:RpcEnvelope[]=[];new ClaudeStreamAdapter('t','c',e=>local.push(e)).accept({...success,result:'',local_command:'compact'});
    expect(local.at(-1)?.params).toMatchObject({turn:{status:'completed'}});
  });
  it('merges single-block SDK snapshots with their real streamed index without merging separate tool calls',()=>{
    const adapter=new ClaudeStreamAdapter('t','r',()=>{});
    const stream=(event:unknown)=>adapter.accept({type:'stream_event',event});
    adapter.accept({type:'assistant',uuid:'empty',message:{id:'m',content:[{type:'thinking',thinking:''}]}});
    stream({type:'message_start',message:{id:'m'}});
    stream({type:'content_block_start',index:1,content_block:{type:'thinking',thinking:''}});
    stream({type:'content_block_delta',index:1,delta:{type:'thinking_delta',thinking:'同一段思考'}});
    stream({type:'content_block_stop',index:1});
    adapter.accept({type:'assistant',uuid:'full',message:{id:'m',content:[{type:'thinking',thinking:'同一段思考'}]}});
    for(const id of ['tool1','tool2'])adapter.accept({type:'assistant',uuid:id,message:{id:'m',content:[{type:'tool_use',id,name:'Bash',input:{command:'pwd'}}]}});
    expect([...adapter.items.values()].filter(i=>i.type==='reasoning')).toHaveLength(1);
    expect([...adapter.items.values()].filter(i=>i.type==='dynamicToolCall')).toHaveLength(2);
  });
  it("feeds the existing live timeline without duplicating the final answer or prematurely completing tools", () => {
    const events: RpcEnvelope[]=[]; const live=new LiveStateStore();
    const adapter=new ClaudeStreamAdapter("t","r",e=>{events.push(e);live.recordNotification(e);});
    const stream=(event:unknown)=>adapter.accept({type:"stream_event",event});
    adapter.start(); adapter.accept(init);
    stream({type:"message_start",message:{id:"m1"}});
    stream({type:"content_block_start",index:0,content_block:{type:"text",text:""}});
    for(const text of ["正在","检查"])stream({type:"content_block_delta",index:0,delta:{type:"text_delta",text}});
    stream({type:"content_block_stop",index:0});
    stream({type:"content_block_start",index:1,content_block:{type:"tool_use",id:"read-1",name:"Read",input:{}}});
    stream({type:"content_block_delta",index:1,delta:{type:"input_json_delta",partial_json:'{"file_path":"demo.txt"}'}});
    stream({type:"content_block_stop",index:1});
    expect(live.snapshot().toolItems[0]).toMatchObject({tool:"Read",completed:false});
    adapter.accept({type:"assistant",uuid:"a1",message:{id:"m1",content:[{type:"text",text:"正在检查"},{type:"tool_use",id:"read-1",name:"Read",input:{file_path:"demo.txt"}}]}});
    adapter.accept({type:"user",message:{content:[{type:"tool_result",tool_use_id:"read-1",content:[{type:"text",text:"hello"}]}]}});
    const snapshot=live.snapshot();
    expect(snapshot.agentMessages.map(m=>m.text)).toEqual(["正在检查"]);
    expect(snapshot.toolItems).toHaveLength(1);
    expect(snapshot.toolItems[0]).toMatchObject({tool:"Read",output:"hello",completed:true});
    adapter.accept(success);adapter.accept(success);
    expect(events.filter(e=>e.method==="turn/completed")).toHaveLength(1);
  });

  it("keeps distinct assistant blocks and marks unfinished tools as unconfirmed on stream failure", () => {
    const events:RpcEnvelope[]=[];const adapter=new ClaudeStreamAdapter("t","r",e=>events.push(e));
    adapter.accept({type:"assistant",message:{id:"m1",content:[{type:"text",text:"A"},{type:"text",text:"B"},{type:"tool_use",id:"tool",name:"Bash",input:{command:"pwd"}}]}});
    adapter.finish("failed","connection closed");
    expect([...adapter.items.values()].filter(i=>i.type==="agentMessage").map(i=>i.text)).toEqual(["A","B"]);
    expect([...adapter.items.values()].find(i=>i.type==="dynamicToolCall")).toMatchObject({status:"interrupted",output:"工具未返回结果，执行结果尚未确认。"});
  });
});
