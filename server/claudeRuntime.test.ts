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

const directories: string[] = [];
afterEach(() => { for (const p of directories.splice(0)) fs.rmSync(p, { recursive: true, force: true }); vi.restoreAllMocks(); });
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
    const factory = vi.fn(async () => query([init,success])); const {runtime,input,notifications} = fixture(factory);
    await runtime.runTurn(input);
    await runtime.runTurn({...input,turnId:"turn-b"});
    const options = (factory.mock.calls as unknown as Array<[string, Options]>).map(c=>c[1]);
    expect(options[0]).toMatchObject({cwd:input.cwd,model:"sonnet",permissionMode:"default",includePartialMessages:true,settingSources:["user","project","local"],tools:{type:"preset",preset:"claude_code"},env:{RECLAUDE_ORG:"org-1"}});
    expect(options[0].resume).toBeUndefined(); expect(options[1].resume).toBe("native-session");
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
});

describe("Claude stream translation", () => {
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
