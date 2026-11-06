import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { CanUseTool, Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {SandboxMode,ApprovalPolicy} from './types.js';
import { CLAUDE_NOT_CONNECTED, isReclaudeModel } from "../shared/agentRuntime.js";
import { AppError } from "./appErrors.js";
import {ClaudeSessionInput,ClaudeTaskLedger} from './claudeSessionInput.js';
import { ClaudeStreamAdapter } from "./claudeStreamAdapter.js";
import {responseLanguageInstructions} from '../scripts/agent-response-style.mjs';
import {claudeMessageUsage,type ClaudeContextSnapshot} from './claudeContextUsage.js';
import {CLAUDE_HISTORY_INSTRUCTIONS,type ClaudeHistoryReader} from './claudeHistoryRecall.js';
import { claudeQuestions, claudeQuestionAnswer } from "./claudeUserInput.js";
import { assertClaudeExecutionAllowed, claudeToolPolicyDenial, enforceClaudeToolPolicy, CLAUDE_EXECUTION_INSTRUCTIONS, type ClaudeExecutionOrigin } from "./claudeExecutionPolicy.js";

/** Supplied by a trusted, server-side binding registry after live verification.
 * This stage deliberately has no HTTP endpoint or environment switch that can
 * create one. Never construct this object from a browser request body. */
export interface VerifiedClaudeBinding {
  userId: string;
  orgId: string;
  executable: string;
  workspaceRoot: string;
  verifiedModels: Readonly<Record<string, string>>;
  configRoot?: string;
}
export interface ClaudeTurnInput {
  documentReader?:(file:string,offset?:number)=>Promise<unknown>;
  mcpServers?:Options['mcpServers'];
  content?:any[];
  sandbox?:SandboxMode;
  approvalPolicy?:ApprovalPolicy;
  effort?: import("../shared/agentRuntime.js").ClaudeEffort;
  userId: string;
  threadId: string;
  turnId: string;
  cwd: string;
  model: string;
  prompt: string;
  executionOrigin?: ClaudeExecutionOrigin;
  skillNames?: readonly string[];
  nativeSessionId?: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  collaborationMode?: "plan" | "default";
  historyReader?:ClaudeHistoryReader;
}
export type ClaudeQuery = AsyncIterable<SDKMessage> & { close(): void;send?(content:any[],id:string):Promise<void>;mcpServerStatus?():Promise<Array<{name:string;status:string}>> };
export type ClaudeQueryFactory = (prompt: string, options: Options, historyReader?:ClaudeHistoryReader,content?:any[],documentReader?:ClaudeTurnInput['documentReader'],initialMessageId?:string) => Promise<ClaudeQuery>;
// A resumed CLI can flush a zero-turn result for an old background notification
// before consuming our initial input. It is not this send's completion.
async function* resumeMessages(query:ClaudeQuery,input:ClaudeTurnInput,waiting:()=>void){
  const iterator=query[Symbol.asyncIterator]();let firstResult=true,mainStarted=false,deadline=0;
  for(;;){
    let timer:ReturnType<typeof setTimeout>|undefined;
    let next:IteratorResult<SDKMessage>;
    try{next=deadline?await Promise.race([iterator.next(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AppError('claude_resume_timeout','Claude 已恢复旧后台状态，但尚未开始处理本轮输入；未重复发送。')),Math.max(1,deadline-Date.now()));})]):await iterator.next();}
    finally{if(timer)clearTimeout(timer);}
    if(next.done)return;
    const m=next.value as any,ids=[m.user_message_uuid,...(Array.isArray(m.user_message_uuids)?m.user_message_uuids:[])];
    if(ids.includes(input.turnId)||m.type==='assistant'&&!m.parent_tool_use_id){mainStarted=true;deadline=0;}
    if(m.type==='result'){
      const handoff=firstResult&&input.resumeSessionId&&!mainStarted&&m.subtype==='success'&&m.is_error===false&&m.num_turns===0&&!m.result&&!m.stop_reason&&!m.terminal_reason&&!m.local_command;
      firstResult=false;
      if(handoff){deadline=Date.now()+60000;waiting();continue;}
    }
    yield next.value;
  }
}
export async function createHistoryMcpServer(historyReader:ClaudeHistoryReader){
  const require = createRequire(new URL("../integrations/claude-session-tools/package.json", import.meta.url));
  const {createSdkMcpServer,tool} = await import(require.resolve("@anthropic-ai/claude-agent-sdk"));
    const {z}=await import(require.resolve('zod'));
    const respond=async(fn:()=>Promise<unknown>)=>{try{return{content:[{type:'text' as const,text:JSON.stringify(await fn())}]};}catch{return{isError:true,content:[{type:'text' as const,text:'历史检索暂不可用或超出本分支范围；原记录未删除，请换关键词重试。'}]};}};
    return createSdkMcpServer({name:'codex_web_history',version:'1.0.0',tools:[
      tool('search','检索本会话和截止分支点的完整继承历史，返回可分页读取的引用。',{query:z.string().min(2).max(128)},(args:any)=>respond(()=>historyReader.search(args.query))),
      tool('read','按引用读取历史原文。nextOffset 非空时可继续读取。',{ref:z.string().max(1024),offset:z.number().int().nonnegative().optional()},(args:any)=>respond(()=>historyReader.read(args.ref,args.offset)))
    ]});
}
const nativeQuery: ClaudeQueryFactory = async (prompt, options,historyReader,content,documentReader,initialMessageId) => {
  const require = createRequire(new URL("../integrations/claude-session-tools/package.json", import.meta.url));
  const { query } = await import(require.resolve("@anthropic-ai/claude-agent-sdk"));
  if(historyReader)options={...options,mcpServers:{...options.mcpServers,codex_web_history:await createHistoryMcpServer(historyReader)},allowedTools:[...(options.allowedTools??[]),'mcp__codex_web_history__search','mcp__codex_web_history__read']};
  if(documentReader){
    const {createSdkMcpServer,tool}=await import(require.resolve('@anthropic-ai/claude-agent-sdk')),{z}=await import(require.resolve('zod'));
    const server=createSdkMcpServer({name:'codex_documents',version:'1.0.0',tools:[tool('read_docx','读取本人工作区或上传目录中的DOCX正文，按nextOffset分页，无需pandoc。',{file:z.string().max(4096),offset:z.number().int().nonnegative().optional()},async(args:any)=>{try{return{content:[{type:'text' as const,text:JSON.stringify(await documentReader(args.file,args.offset))}]};}catch{return{isError:true,content:[{type:'text' as const,text:'DOCX读取失败：检查本人文件路径、文件格式或大小；原文件未修改。'}]};}})]});
    options={...options,mcpServers:{...options.mcpServers,codex_documents:server},allowedTools:[...(options.allowedTools??[]),'mcp__codex_documents__read_docx']};
  }
  // Tool permission callbacks require streaming input even for a single prompt.
  const input=new ClaudeSessionInput();
  input.push({type:'user',uuid:initialMessageId,message:{role:'user',content:content??prompt},parent_tool_use_id:null,session_id:''});
  const stream = query({ prompt: input, options });
  return {
    [Symbol.asyncIterator]: () => stream,
    send:async(content,id)=>{input.steer(content,id);},
    mcpServerStatus:()=>stream.mcpServerStatus().then((rows:Array<{name:string;status:string}>)=>rows.map(row=>({name:row.name,status:row.status}))),
    close: () => { input.close();options.abortController?.abort(); void stream.return(undefined).catch(() => {}); }
  };
};
export {nativeQuery as nativeClaudeQuery};
interface PendingApproval {
  userId: string;
  threadId: string;
  kind: "approval" | "question";
  answer?(result: unknown): void;
  settle(result: PermissionResult): void;
  allow: PermissionResult;
}

/** Native Claude execution adapter; the pre-auth application never activates
 * it. Tests inject an SDK fixture, so no credentials, CLI or model are used. */
export class ClaudeRuntime extends EventEmitter {
  private active = new Map<string, { controller: AbortController; query?: ClaudeQuery;ready?:Promise<ClaudeQuery>;stopReason?: string | AppError;turnId:string;adapter:ClaudeStreamAdapter;pendingSteers:Set<string>;steers:Map<string,{fingerprint:string;promise:Promise<unknown>}> }>();
  private sessions = new Map<string, string>();
  private pending = new Map<string, PendingApproval>();

  constructor(private binding: VerifiedClaudeBinding | null = null, private factory: ClaudeQueryFactory = nativeQuery) { super(); }

  private ownedBinding(userId: string): VerifiedClaudeBinding {
    if (!this.binding) throw new AppError("runtime_not_connected", CLAUDE_NOT_CONNECTED);
    if (this.binding.userId !== userId) throw new AppError("runtime_forbidden", "无权使用此 Claude 账号。");
    return this.binding;
  }

  sessionForThread(userId: string, threadId: string): string | null {
    this.ownedBinding(userId);
    return this.sessions.get(threadId) ?? null;
  }
  mcpStatus(threadId:string){return this.active.get(threadId)?.query?.mcpServerStatus?.()??Promise.resolve(null);}

  async runTurn(input: ClaudeTurnInput): Promise<void> {
    assertClaudeExecutionAllowed(input);
    const binding = this.ownedBinding(input.userId);
    const nativeModel = Object.hasOwn(binding.verifiedModels, input.model) ? binding.verifiedModels[input.model] : undefined;
    if (!isReclaudeModel(input.model) || !nativeModel) throw new AppError("unsupported_model", "此账号尚未验证所选 Claude 模型。");
    if (!input.prompt.trim()) throw new Error("Prompt is required.");
    if (!input.threadId || !input.turnId) throw new Error("A thread and turn identity are required.");
    if (this.active.has(input.threadId)) throw new AppError("turn_in_progress", "该 Claude 会话正在运行。");
    const root = fs.realpathSync(binding.workspaceRoot), cwd = fs.realpathSync(input.cwd);
    const relative = path.relative(root, cwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new AppError("workspace_forbidden", "Claude 工作目录不属于当前用户。");
    }
    if (!path.isAbsolute(binding.executable)) throw new Error("ReClaude executable must be an absolute path.");
    fs.accessSync(binding.executable, fs.constants.X_OK);
    const controller = new AbortController();
    const adapter = new ClaudeStreamAdapter(input.threadId, input.turnId, event => this.emit("notification", event));
    const state:NonNullable<ReturnType<typeof this.active.get>>={controller,turnId:input.turnId,adapter,pendingSteers:new Set(),steers:new Map()};
    this.active.set(input.threadId, state);
    const tasks=new ClaudeTaskLedger();
    const usageTotals:Record<string,number>={},seenResults=new Set<string>();let nativeResults=0,thinkingTokens=0,thinkingObserved=false;
    const fullAccessNoAsk=input.sandbox==='danger-full-access'&&input.approvalPolicy==='never'&&input.collaborationMode!=='plan';
    const canUseTool: CanUseTool = (name, original, context) => {
      const policyDenial = claudeToolPolicyDenial(name, original);
      if (policyDenial) return Promise.resolve({ behavior: "deny", message: policyDenial });
      if(input.sandbox==='read-only'&&['Bash','Write','Edit','NotebookEdit','Agent','Task','ExitPlanMode'].includes(name))return Promise.resolve({behavior:'deny',message:'当前会话为只读模式，请使用读取、搜索工具；修改权限后才能执行或写入。'});
      if (controller.signal.aborted || context.signal.aborted) return Promise.resolve({ behavior: "deny", message: "本轮已取消。" });
      // Never permit the UI to replace the input or grant broader permissions.
      const toolInput = structuredClone(original);
      const question = name === "AskUserQuestion";
      const toolUseId=context.toolUseID;
      const questions=question?claudeQuestions(toolInput,toolUseId):[];
      if(question&&(!questions.length||questions.some(q=>typeof q.question!=="string"||!q.question.trim()))) {
        return Promise.resolve({behavior:"deny",message:"提问格式不完整，请重新生成问题。"});
      }
      if(input.approvalPolicy==='never'&&!question&&input.collaborationMode!=='plan')return Promise.resolve({behavior:'deny',message:'当前设置为不询问；此调用未获原生权限策略自动批准，已拒绝而非弹出批准。需要执行时请检查会话权限或具体工具限制。'});
      const id = `${question?"claude-input":"claude-approval"}:${randomUUID()}`;
      return new Promise<PermissionResult>(resolve => {
        let settled = false;
        const settle = (result: PermissionResult) => {
          if (settled) return;
          settled = true;
          this.pending.delete(id);
          controller.signal.removeEventListener("abort", aborted);
          context.signal.removeEventListener("abort", aborted);
          resolve(result);
        };
        const aborted = () => settle({behavior:"deny",message:"本轮已取消。"});
        this.pending.set(id, { userId: input.userId, threadId: input.threadId, kind:question?"question":"approval", settle,
          allow: {behavior:"allow",updatedInput:toolInput},
          ...(question?{answer:(result:unknown)=>settle({behavior:"allow",updatedInput:claudeQuestionAnswer(toolInput,toolUseId,result)})}:{}) });
        controller.signal.addEventListener("abort", aborted, { once: true });
        context.signal.addEventListener("abort", aborted, { once: true });
        this.emit("serverRequest", question?{id,method:"item/tool/requestUserInput",params:{
          threadId:input.threadId,turnId:input.turnId,itemId:toolUseId,questions:structuredClone(questions),isBlocking:true
        }}:{ id, method: "item/claudeTool/requestApproval", params: {
          threadId: input.threadId, turnId: input.turnId,
          toolName: name, toolInput: structuredClone(toolInput),
          reason: name==="ExitPlanMode"?"Claude 已完成计划。批准后可开始执行，拒绝则继续讨论计划。":context.decisionReason ?? "Claude 请求执行此操作。",
          availableDecisions: ["decline", "accept"]
        } });
      });
    };
    adapter.start();
    let contextSnapshot:ClaudeContextSnapshot|null=null,mcpObserved=false;
    try {
      const env = { ...process.env };
      // The bound wrapper supplies Claude auth. Do not forward another provider's
      // backend credentials (or an unrelated inherited Anthropic login) to tools.
      for (const key of Object.keys(env)) if (/^(?:CODEX_WEB_|OPENAI_|ARK_|MIMO_|ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL)$)/.test(key)) delete env[key];
      state.ready = this.factory(input.prompt, {
        cwd, model: nativeModel,
        ...(input.effort?{effort:input.effort}:{}),
        pathToClaudeCodeExecutable: binding.executable,
        env: { ...env, RECLAUDE_ORG: binding.orgId, CLAUDE_CODE_DISABLE_WORKFLOWS: "1", ...(binding.configRoot ? { CLAUDE_CONFIG_DIR: binding.configRoot } : {}) },
        abortController: controller,
        permissionMode: input.collaborationMode === "plan" ? "plan" : fullAccessNoAsk ? 'bypassPermissions' : "default",
        ...(fullAccessNoAsk?{allowDangerouslySkipPermissions:true,sandbox:{enabled:false}}:{}),
        canUseTool,
        mcpServers:input.mcpServers,
        ...(input.sandbox==='read-only'?{allowedTools:['Read','Glob','Grep','WebSearch','WebFetch']}:{}),
        hooks: { PreToolUse: [{ hooks: [enforceClaudeToolPolicy,async(event)=>{
          if(event.hook_event_name!=='PreToolUse')return {};
          const name=event.tool_name,args=event.tool_input as Record<string,unknown>;
          let reason:string|undefined;
          if(input.sandbox==='read-only'&&['Bash','Write','Edit','NotebookEdit','Agent','Task','ExitPlanMode'].includes(name))reason='当前会话为只读模式，不执行命令、启动子代理或写入文件。';
          if(input.sandbox==='workspace-write'&&['Write','Edit','NotebookEdit'].includes(name)){
            const target=args.file_path??args.notebook_path;
            if(typeof target==='string'){
              const resolved=path.resolve(cwd,target);let parent=path.dirname(resolved);while(!fs.existsSync(parent)&&parent!==path.dirname(parent))parent=path.dirname(parent);
              if(!resolved.startsWith(cwd+path.sep)||!fs.realpathSync(parent).startsWith(cwd+path.sep)&&fs.realpathSync(parent)!==cwd||fs.existsSync(resolved)&&!fs.realpathSync(resolved).startsWith(cwd+path.sep))reason='当前会话仅允许在工作区内写入。';
            }
          }
          if(reason)return{hookSpecificOutput:{hookEventName:'PreToolUse' as const,permissionDecision:'deny' as const,permissionDecisionReason:reason}};
          if(['Agent','Task'].includes(name)&&typeof args.prompt==='string'&&!args.prompt.includes(responseLanguageInstructions))return{hookSpecificOutput:{hookEventName:'PreToolUse' as const,updatedInput:{...args,prompt:args.prompt+'\n\n'+responseLanguageInstructions}}};
          return {};
        }] }] },
        ...(input.sandbox==='workspace-write'?{sandbox:{enabled:true,failIfUnavailable:true,allowUnsandboxedCommands:false,autoAllowBashIfSandboxed:input.approvalPolicy==='never'}}:{}),
        includePartialMessages: true,
        // Preserve Claude Code's native tools, skills, CLAUDE.md and MCP config.
        systemPrompt: { type: "preset", preset: "claude_code", append: responseLanguageInstructions+'\n\n'+CLAUDE_EXECUTION_INSTRUCTIONS+(input.historyReader?'\n'+CLAUDE_HISTORY_INSTRUCTIONS:'')+'\n联网优先使用可用的 WebSearch/WebFetch；抓取失败时可使用 codex_browser 浏览器工具。网页 TLS、站点拒绝或工具失败，不代表所有联网能力都不可用。不得关闭 TLS 校验。DOCX优先使用codex_documents.read_docx分页读取正文，无需pandoc；提取正文不等于已读取图片或版式。' },
        tools: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        ...(input.resumeSessionId ? { resume: input.resumeSessionId, forkSession: input.forkSession ?? false }
          : this.sessions.has(input.threadId) ? { resume: this.sessions.get(input.threadId) } : {}),
        extraArgs: {
          settings: JSON.stringify({ disableWorkflows: true,fastMode:false }),
          ...(input.nativeSessionId && (!input.resumeSessionId || input.forkSession) ? { "session-id": input.nativeSessionId } : {})
        }
      },input.historyReader,input.content,input.documentReader,input.turnId);
      state.query=await state.ready;
      if (controller.signal.aborted) { adapter.finish("interrupted", state.stopReason); return; }
      for await (const message of resumeMessages(state.query,input,()=>this.emit('notification',{method:'runtime/claudeResumePending',params:{threadId:input.threadId,turnId:input.turnId}}))) {
        if (controller.signal.aborted) break;
        const candidate=claudeMessageUsage(message);
        if(candidate){contextSnapshot=candidate;this.emit('contextUsage',candidate);}
        const envelope=message as any;
        if(envelope.type==='result'){
          const key=typeof envelope.uuid==='string'?envelope.uuid:Number.isSafeInteger(envelope.result_index)?String(envelope.result_index):null;
          if(key&&seenResults.has(key))continue;if(key)seenResults.add(key);nativeResults++;
          for(const field of ['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens']){const value=envelope.usage?.[field];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)usageTotals[field]=(usageTotals[field]??0)+value;}
          const thinking=envelope.usage?.output_tokens_details?.thinking_tokens;if(typeof thinking==='number'&&Number.isFinite(thinking)&&thinking>=0){thinkingTokens+=thinking;thinkingObserved=true;}
        }
        const tasksChanged=tasks.update(envelope);
        if(tasksChanged)this.emit('notification',{method:'runtime/claudeTasks',params:{threadId:input.threadId,turnId:input.turnId,tasks:tasks.snapshot()}});
        if(envelope.type==='system'&&envelope.subtype==='task_progress'&&!envelope.ambient)this.emit('notification',{method:'runtime/claudeTaskProgress',params:{threadId:input.threadId,turnId:input.turnId,taskId:envelope.task_id}});
        for(const id of [envelope.user_message_uuid,...(Array.isArray(envelope.user_message_uuids)?envelope.user_message_uuids:[])])if(typeof id==='string')state.pendingSteers.delete(id);
        if(envelope.type==='result'&&contextSnapshot){
          const reportedWindow:unknown=envelope.modelUsage?.[contextSnapshot.model]?.contextWindow;
          if(typeof reportedWindow==='number'&&Number.isFinite(reportedWindow)&&reportedWindow>0){contextSnapshot={...contextSnapshot,contextWindow:reportedWindow,windowSource:'runtime'};this.emit('contextUsage',contextSnapshot);}
        }
        if ((message as {type:string}).type === "rate_limit_event") {
          this.emit("rateLimit", message);
          if (controller.signal.aborted) break;
        }
        if (message.type === "assistant") this.emit("nativeCheckpoint", { messageId: message.uuid });
        if(envelope.type==='result'&&envelope.terminal_reason==='aborted_streaming'&&state.pendingSteers.size){
          this.emit('notification',{method:'runtime/claudeSteerPending',params:{threadId:input.threadId,turnId:input.turnId}});
          continue;
        }
        if(envelope.type==='result'&&envelope.subtype==='success'&&!envelope.is_error&&(tasks.pending.length||state.pendingSteers.size||envelope.queued_turn_count>0)){
          this.emit('notification',{method:'runtime/claudeBackgroundWait',params:{threadId:input.threadId,turnId:input.turnId,pendingTasks:tasks.pending.length,pendingMessages:state.pendingSteers.size}});
          continue;
        }
        adapter.accept(envelope.type==='result'&&nativeResults>1?{...envelope,usage:{...envelope.usage,...usageTotals,...(thinkingObserved?{output_tokens_details:{...envelope.usage?.output_tokens_details,thinking_tokens:thinkingTokens}}:{})}}:message);
        if(tasksChanged)adapter.updateTasks(tasks.snapshot());
        if(message.type==='assistant'&&!mcpObserved&&state.query.mcpServerStatus){
          mcpObserved=true;
          void state.query.mcpServerStatus().then(mcpServers=>{if(!controller.signal.aborted&&adapter.capabilities)this.emit('notification',{method:'runtime/initialized',params:{threadId:input.threadId,turnId:input.turnId,runtime:'claude-code',...adapter.capabilities,mcpServers}});}).catch(()=>{});
        }
        if (adapter.sessionId && this.sessions.get(input.threadId)!==adapter.sessionId) {
          this.sessions.set(input.threadId, adapter.sessionId);
          this.emit("nativeSession", { threadId: input.threadId, sessionId: adapter.sessionId });
        }
        if (adapter.finished) break;
      }
      if (!adapter.finished) adapter.finish(controller.signal.aborted ? "interrupted" : "failed",
        controller.signal.aborted ? state.stopReason : "Claude 输出在完成标记之前中断，结果尚未确认。");
    } catch (error) {
      adapter.finish(controller.signal.aborted ? "interrupted" : "failed", controller.signal.aborted ? state.stopReason : String(error));
    } finally {
      // Termination must release callbacks waiting for UI approval.
      controller.abort();
      state.query?.close();
      if(tasks.pending.length){tasks.stop();this.emit('notification',{method:'runtime/claudeTasks',params:{threadId:input.threadId,turnId:input.turnId,tasks:tasks.snapshot()}});}
      this.active.delete(input.threadId);
    }
  }

  steer(userId:string,threadId:string,expectedTurnId:string,submission:{prompt:string;content?:any[];parts:any[];clientId?:string}){
    this.ownedBinding(userId);assertClaudeExecutionAllowed({prompt:submission.prompt,skillNames:submission.parts.filter(p=>p.type==='skill').map(p=>p.name)});
    const state=this.active.get(threadId);
    if(!state||state.turnId!==expectedTurnId||state.adapter.finished||state.controller.signal.aborted)throw new AppError('turn_changed','当前轮次已结束或变化，未发送引导消息。');
    const key=submission.clientId??randomUUID(),fingerprint=JSON.stringify(submission.parts),existing=state.steers.get(key);
    if(existing){if(existing.fingerprint!==fingerprint)throw Error('重复请求的引导内容不一致。');return existing.promise;}
    if(state.pendingSteers.size>=8)throw Error('请等待已发送的引导消息被处理。');
    const id=randomUUID();state.pendingSteers.add(id);
    const promise=(async()=>{try{
      const query=await state.ready;
      if(!query?.send)throw new AppError('unsupported_operation','当前原生客户端没有流式追加输入接口。');
      if(state.adapter.finished||state.controller.signal.aborted)throw new AppError('turn_changed','当前轮次已结束，未发送引导消息。');
      await query.send(submission.content??[{type:'text',text:submission.prompt}],id);
      state.adapter.recordUserInput(id,submission.parts);
      return {turnId:state.turnId,steerId:id};
    }catch(error){state.pendingSteers.delete(id);throw error;}})();
    state.steers.set(key,{fingerprint,promise});return promise;
  }

  answerApproval(userId: string, id: string, decision: unknown): void {
    this.ownedBinding(userId);
    const pending = this.pending.get(id);
    if (!pending || pending.userId !== userId || pending.kind!=="approval") throw new Error("批准请求不存在或已结束。");
    if (decision !== "accept" && decision !== "decline") throw new Error("Claude 仅支持批准本次操作或拒绝。");
    pending.settle(decision==="accept"?pending.allow:{behavior:"deny",message:"用户未批准此操作。"});
  }

  answerUserInput(userId: string, id: string, result: unknown): void {
    this.ownedBinding(userId);
    const pending=this.pending.get(id);
    if(!pending||pending.userId!==userId||pending.kind!=="question"||!pending.answer)throw new Error("提问不存在或已结束。");
    pending.answer(result);
  }
  rejectRequest(userId: string, id: string): void {
    this.ownedBinding(userId);
    const pending=this.pending.get(id);
    if(!pending||pending.userId!==userId)throw new Error("请求不存在或已结束。");
    pending.settle({behavior:"deny",message:"用户已取消此请求。"});
  }

  interrupt(userId: string, threadId: string, reason?: string | AppError): void {
    this.ownedBinding(userId);
    const state = this.active.get(threadId);
    if (state && reason) state.stopReason = reason;
    state?.controller.abort();
    state?.query?.close();
  }
}
