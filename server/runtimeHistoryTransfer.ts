import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { CodexBridge } from "./codexBridge.js";
import type { ProjectStore } from "./db.js";
import { getClaudeService, type ClaudeService } from "./claudeService.js";
import { AppError } from "./appErrors.js";
import { isReclaudeModel } from "../shared/agentRuntime.js";
import { findThreadJsonlPathById } from "./threadFallback.js";
import { rolloutLines, rolloutReadStream, rolloutLogicalStat } from "./rolloutStorage.js";
import { isAccountPoolBridge } from "./accountPoolBridge.js";
import type { ClaudeConversation } from "./claudeSessionStorage.js";

type Row = Record<string, any>;
type TransferEffort="low"|"medium"|"high"|"xhigh"|"max"|"ultra";
const record = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
export interface TransferMessage { role: "user" | "assistant"; text: string; sourceId?: string; }
interface Transfer {
  id: string; userId: string; sourceThreadId: string; projectId: string; targetModel: string;
  sourceTurnId?: string; targetAccountId?: string; targetReasoningEffort?:TransferEffort;
  sourceRuntime: "codex" | "claude-code"; phase: "preparing" | "prepared" | "creating" | "importing" | "completed" | "uncertain";
  sourceName: string; sourceHash?: string; archive?: string; messageCount: number; importedCount: number;
  warnings: string[]; targetThreadId?: string; nativeSessionId?: string; createdAt: number;
}
export interface TransferRequest { operationId: string; sourceThreadId: string; userId: string; projectId: string; targetModel: string; targetAccountId?: string; sourceTurnId?: string;targetReasoningEffort?:TransferEffort; }
const transferServices=new WeakMap<object,RuntimeHistoryTransfer>();
export function getRuntimeHistoryTransfer(bridge: CodexBridge, store: ProjectStore) {
  let service=transferServices.get(bridge);
  const claude=getClaudeService(bridge);
  if(!service&&claude){service=new RuntimeHistoryTransfer(claude,bridge,store);transferServices.set(bridge,service);}
  return service;
}

/** Native stores remain owned by their runtimes. This journal stores immutable
 * source snapshots, ordered portable messages and import checkpoints shared by
 * both engines. An import is a snapshot, never a two-way replay loop. */
export class RuntimeHistoryTransfer {
  private active = new Map<string, Promise<unknown>>();
  constructor(private claude: ClaudeService, private bridge: CodexBridge, private store: ProjectStore) {
    claude.storage.db.exec(`CREATE TABLE IF NOT EXISTS runtime_transfers (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_transfer_items (transfer_id TEXT NOT NULL, seq INTEGER NOT NULL, turn_id TEXT, body TEXT NOT NULL, PRIMARY KEY(transfer_id,seq));`);
    // Reclassify known historical Codex targets without deleting the audit
    // ledger or releasing any actual Claude creation/fork reservations.
    claude.storage.db.exec(`UPDATE creations SET runtime='codex' WHERE runtime='claude-code' AND session_id IN
      (SELECT id FROM runtime_transfers WHERE json_extract(body,'$.targetModel') IS NOT NULL
       AND json_extract(body,'$.targetModel') NOT LIKE 'reclaude-%')`);
  }
  private get(id: string): Transfer | null {
    const found = this.claude.storage.db.prepare("SELECT body FROM runtime_transfers WHERE id=?").get(id) as {body:string}|undefined;
    return found ? JSON.parse(found.body) : null;
  }
  private save(row: Transfer) {
    this.claude.storage.db.prepare("INSERT INTO runtime_transfers VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(row.id, JSON.stringify(row));
  }
  private *messages(id: string): Generator<TransferMessage> {
    // Iterate in bounded pages: no full conversation array in the web process.
    let seq = -1;
    for (;;) {
      const rows = this.claude.storage.db.prepare("SELECT seq,body FROM runtime_transfer_items WHERE transfer_id=? AND seq>? ORDER BY seq LIMIT 1")
        .all(id, seq) as Array<{seq:number;body:string}>;
      if (!rows.length) return;
      seq = rows[0].seq; yield JSON.parse(rows[0].body);
    }
  }
  async migrate(input: TransferRequest): Promise<unknown> {
    const existing = this.get(input.operationId);
    if (existing && (existing.userId !== input.userId || existing.sourceThreadId !== input.sourceThreadId || existing.projectId !== input.projectId || existing.targetModel !== input.targetModel || existing.sourceTurnId !== input.sourceTurnId || existing.targetAccountId !== input.targetAccountId || existing.targetReasoningEffort !== input.targetReasoningEffort)) {
      throw new AppError("migration_conflict", "迁移请求标识已用于另一个目标，请重新打开迁移窗口。");
    }
    const running = this.active.get(input.operationId);
    if (running) return running;
    const promise = this.run(input);
    this.active.set(input.operationId, promise);
    try { return await promise; } finally { this.active.delete(input.operationId); }
  }
  private result(row: Transfer) {
    return { threadId: row.targetThreadId!, sourceThreadId: row.sourceThreadId, model: row.targetModel,
      operationId: row.id, messageCount: row.messageCount, warnings: row.warnings,
      historySourceUrl: `/api/projects/${row.projectId}/threads/${row.sourceThreadId}/migration-source/${row.id}` };
  }
  archive(id: string, userId: string, sourceThreadId: string) {
    const row = this.get(id);
    if (!row || row.userId !== userId || row.sourceThreadId !== sourceThreadId || !row.archive) return null;
    return row.archive;
  }
  private async run(input: TransferRequest) {
    const project = this.store.getProject(input.projectId, input.userId);
    if (!project || !this.store.userCanAccessThread(input.sourceThreadId, input.userId, input.projectId)) throw new AppError("runtime_forbidden", "无权迁移此会话。");
    let row = this.get(input.operationId);
    if (row?.phase === "completed") return this.result(row);
    if (row && ["creating", "importing", "uncertain"].includes(row.phase)) throw new AppError("migration_uncertain", "此前迁移的提交结果尚未确认，已阻止重复创建或重复导入。原会话完整保留，请查看迁移记录。");
    if(isReclaudeModel(input.targetModel))this.claude.storage.assertCapacity(input.operationId);
    const sourceRuntime = this.claude.owns(input.sourceThreadId) ? "claude-code" : "codex";
    if ((sourceRuntime === "claude-code") === isReclaudeModel(input.targetModel)) throw new AppError("migration_target", "请选择另一运行引擎；同引擎请使用原生分支。");
    if (isReclaudeModel(input.targetModel)) this.claude.usage.assertAvailable(this.claude.bindings.resolve(input.userId, input.targetModel));
    if (!row) {
      row = { id: input.operationId, sourceThreadId: input.sourceThreadId, userId: input.userId, projectId: input.projectId,
        targetModel: input.targetModel, sourceTurnId:input.sourceTurnId, targetAccountId:input.targetAccountId,targetReasoningEffort:input.targetReasoningEffort, sourceRuntime, sourceName: "会话", phase: "preparing", messageCount: 0, importedCount: 0,
        warnings: [], createdAt: Date.now() };
      this.save(row);
    }
    if (row.phase === "preparing") {
      if (sourceRuntime === "claude-code") {
        await this.claude.withHistorySnapshot(input.sourceThreadId, (file, source) => {
          row!.sourceName = source.name; return this.snapshot(row!, file);
        });
      } else {
        const snapshot = async (runtime: CodexBridge) => {
          const summary = record(record(await runtime.request("thread/read", {threadId:input.sourceThreadId,includeTurns:false}, 30_000)).thread);
          if (summary.status?.type === "active") throw new AppError("turn_in_progress", "请先结束当前轮次再迁移会话。");
          const source = await findThreadJsonlPathById(input.sourceThreadId);
          if (!source) throw new AppError("migration_history_missing", "原生历史尚未持久化，未创建目标会话。");
          row!.sourceName = this.store.getThreadPresentation(input.userId,[input.sourceThreadId]).get(input.sourceThreadId)?.displayName ?? summary.name ?? summary.preview ?? "会话";
          await this.snapshot(row!, source);
        };
        if (isAccountPoolBridge(this.bridge)) await this.bridge.withThreadMaintenance(input.sourceThreadId, snapshot);
        else await snapshot(this.bridge);
      }
    }
    // Only a Claude destination creates a native Claude session. Codex targets
    // neither consume a Claude slot nor wait for that budget to reset.
    if(isReclaudeModel(row.targetModel))this.claude.storage.reserve(row.id);
    try {
      if (isReclaudeModel(row.targetModel)) await this.importClaude(row, project.rootPath);
      else {
        const execution=this.store.getThreadExecutionSettings(input.sourceThreadId,input.userId);
        await this.importCodex(row,execution?{...project,defaultSandbox:execution.sandbox,defaultApprovalPolicy:execution.approvalPolicy}:project,input.targetAccountId);
      }
      const execution=this.store.getThreadExecutionSettings(input.sourceThreadId,input.userId);
      this.store.setThreadExecutionSettings(row.targetThreadId!,input.userId,execution?.sandbox??project.defaultSandbox,execution?.approvalPolicy??project.defaultApprovalPolicy);
      row.phase = "completed"; this.save(row);
      this.store.updateThreadDisplayName(row.targetThreadId!, row.userId, `${row.sourceName} · 迁移`);
      return this.result(row);
    } catch (error) {
      if (["creating","importing"].includes(row.phase)) { row.phase="uncertain";this.save(row); }
      throw error;
    }
  }
  private async snapshot(row: Transfer, source: string) {
    const dir = path.join(this.claude.config.storageDirectory, "transfers", row.id);
    fs.mkdirSync(dir, {recursive:true,mode:0o700});
    const archive = path.join(dir, "source.jsonl"), partial = path.join(dir, `source-${randomUUID()}.partial`);
    const before = await rolloutLogicalStat(source), hash = createHash("sha256");
    await pipeline(await rolloutReadStream(source, {}, 0), new Transform({transform(chunk, _encoding, done) {hash.update(chunk);done(null,chunk);}}), fs.createWriteStream(partial,{flags:"wx",mode:0o600}));
    const after = await rolloutLogicalStat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new AppError("migration_source_busy", "源历史在读取期间发生变化，未创建目标会话，请稍后重试。");
    fs.renameSync(partial, archive);
    row.archive=archive;row.sourceHash=hash.digest("hex");row.messageCount=0;row.warnings=[];
    this.claude.storage.db.prepare("DELETE FROM runtime_transfer_items WHERE transfer_id=?").run(row.id);
    const insert=this.claude.storage.db.prepare("INSERT INTO runtime_transfer_items VALUES (?,?,?,?)");
    let turnId: string|null=null, skippedInternal=0, rawMessages=0, codexIdentityVerified=false;
    let claudeCutoff:string|undefined, cutoffFound=false;
    if(row.sourceRuntime==="claude-code"&&row.sourceTurnId){
      const selected=this.claude.storage.turn(row.sourceTurnId);
      if(typeof selected?.nativeMessageId!=="string"||!selected.nativeMessageId||selected.nativeSessionId!==this.claude.storage.get(row.sourceThreadId)?.nativeSessionId)
        throw new AppError("migration_cutoff_missing","所选轮次没有可确认的原生分支位置，未创建目标会话。");
      claudeCutoff=selected.nativeMessageId;
    }
    const seen = new Set<string>();
    for await (const line of rolloutLines(archive)) {
      if(cutoffFound)break;
      if (!line.trim()) continue;
      const raw=record(JSON.parse(line));
      if (row.sourceRuntime==="codex") {
        const p=record(raw.payload);
        // Native forks prepend their own session header, then retain headers
        // from inherited rollouts. Only the first record identifies the source;
        // ancestor headers are history, not another source selection.
        if (!codexIdentityVerified) {
          if (raw.type!=="session_meta" || p.id!==row.sourceThreadId) throw new AppError("migration_identity_mismatch", "历史文件与源会话不一致。");
          codexIdentityVerified=true;
          continue;
        }
        if (raw.type==="session_meta") continue;
        if (raw.type==="turn_context" && typeof p.turn_id==="string") turnId=p.turn_id;
        if (raw.type==="event_msg" && p.type==="task_started") turnId=p.turn_id;
        if (raw.type==="event_msg" && p.type==="thread_rolled_back") {
          const count=Number(p.num_turns);
          if (!Number.isSafeInteger(count)||count<1) throw new AppError("migration_unsupported", "无法确认历史撤回范围，原记录未改动。");
          const turns=this.claude.storage.db.prepare("SELECT turn_id,MAX(seq) AS n FROM runtime_transfer_items WHERE transfer_id=? AND turn_id IS NOT NULL GROUP BY turn_id ORDER BY n DESC LIMIT ?").all(row.id,count) as Array<{turn_id:string}>;
          for(const turn of turns)this.claude.storage.db.prepare("DELETE FROM runtime_transfer_items WHERE transfer_id=? AND turn_id=?").run(row.id,turn.turn_id);
          continue;
        }
        if(raw.type!=="response_item")continue;
        if(p.type==="reasoning"){skippedInternal++;continue;}
        const message=portableCodexItem(p);
        if(!message){if(p.type!=="message")skippedInternal++;continue;}
        if(p.id&&seen.has(p.id))continue;if(p.id)seen.add(p.id);
        insert.run(row.id,rawMessages++,turnId,JSON.stringify(message));
      } else {
        if(raw.sessionId && raw.sessionId!==this.claude.storage.get(row.sourceThreadId)?.nativeSessionId) throw new AppError("migration_identity_mismatch","Claude 历史标识不一致。");
        if(raw.isSidechain===true)continue;
        if(claudeCutoff&&raw.uuid===claudeCutoff)cutoffFound=true;
        if(!["user","assistant"].includes(raw.type))continue;
        if(raw.uuid&&seen.has(raw.uuid))continue;if(raw.uuid)seen.add(raw.uuid);
        const message=portableClaudeMessage(raw);
        if(!message){skippedInternal++;continue;}
        insert.run(row.id,rawMessages++,null,JSON.stringify(message));
      }
    }
    if(row.sourceTurnId&&row.sourceRuntime==="codex"){
      const cutoff=this.claude.storage.db.prepare("SELECT MAX(seq) AS n FROM runtime_transfer_items WHERE transfer_id=? AND turn_id=?").get(row.id,row.sourceTurnId)?.n;
      if(cutoff===null||cutoff===undefined)throw new AppError("migration_cutoff_missing","未找到所选分支轮次，未创建目标会话。");
      this.claude.storage.db.prepare("DELETE FROM runtime_transfer_items WHERE transfer_id=? AND seq>?").run(row.id,cutoff as number);
    }
    if(claudeCutoff&&!cutoffFound)throw new AppError("migration_cutoff_missing","源记录中没有所选原生分支位置，未创建目标会话。");
    row.messageCount=Number((this.claude.storage.db.prepare("SELECT COUNT(*) AS n FROM runtime_transfer_items WHERE transfer_id=?").get(row.id) as {n:number}).n);
    if(!row.messageCount)throw new AppError("migration_empty","没有可迁移的对话内容，未创建目标会话。");
    row.warnings.push("已迁移用户消息、可见回答和工具记录；工具记录作为文字保留，不会执行。原生内部状态与附件原始数据保存在源记录中。");
    if(skippedInternal)row.warnings.push(`原始记录中的 ${skippedInternal} 条推理或内部状态没有转换为可执行上下文，完整原件已保留。`);
    row.phase="prepared";this.save(row);
  }
  private async importClaude(row: Transfer,cwd:string) {
    const binding=this.claude.bindings.resolve(row.userId,row.targetModel);
    const effort=this.claude.bindings.effort(row.userId,row.targetModel,row.targetReasoningEffort);
    this.claude.usage.assertAvailable(binding);
    const relative=path.relative(fs.realpathSync(binding.workspaceRoot),fs.realpathSync(cwd));
    if(relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new AppError("workspace_forbidden","迁移目标工作目录不属于当前用户。");
    row.targetThreadId=randomUUID();row.nativeSessionId=randomUUID();row.phase="importing";this.save(row);
    const folder=path.join(binding.configRoot,"projects",cwd.replace(/[^a-zA-Z0-9]/g,"-"));
    fs.mkdirSync(folder,{recursive:true,mode:0o700});
    if(!fs.realpathSync(folder).startsWith(fs.realpathSync(binding.configRoot)+path.sep))throw new Error("迁移目录越界。");
    const nativeFile=path.join(folder,`${row.nativeSessionId}.jsonl`),fd=fs.openSync(nativeFile,"wx",0o600);
    let parent:string|null=null;
    try {
      for (const message of this.messages(row.id)) {
        const uuid=randomUUID(),timestamp=new Date(row.createdAt).toISOString();
        const native={type:message.role,uuid,parentUuid:parent,sessionId:row.nativeSessionId,cwd,isSidechain:false,timestamp,
          version:"2.1.316",message:{role:message.role,content:[{type:"text",text:message.text}],
            ...(message.role==="assistant"?{id:randomUUID(),type:"message",model:"historical-import",stop_reason:"end_turn",usage:{input_tokens:0,output_tokens:0}}:{})}};
        fs.writeSync(fd,JSON.stringify(native)+"\n");parent=uuid;
        const id=randomUUID();
        this.claude.storage.saveTurn(row.targetThreadId,{id,status:"completed",nativeMessageId:uuid,nativeSessionId:row.nativeSessionId,items:[message.role==="user"
          ?{id:`import:${id}`,type:"userMessage",content:[{type:"text",text:message.text}]}
          :{id:`import:${id}`,type:"agentMessage",text:message.text}]});
        row.importedCount++;
      }
      fs.fsyncSync(fd);
    } finally {fs.closeSync(fd);}
    const conversation:ClaudeConversation={id:row.targetThreadId,nativeSessionId:row.nativeSessionId,userId:row.userId,projectId:row.projectId,cwd,
      name:`${row.sourceName} · 迁移`,model:row.targetModel,orgId:binding.orgId,accountKey:binding.accountKey,configRoot:binding.configRoot,
      initialized:true,archived:false,createdAt:Date.now(),updatedAt:Date.now()};
    this.claude.storage.save(conversation);
    this.store.registerThreadOwner({threadId:row.targetThreadId,userId:row.userId,projectId:row.projectId,rootPath:cwd,model:row.targetModel,reasoningEffort:effort??"medium"});
  }
  private async importCodex(row:Transfer,project:{rootPath:string;defaultApprovalPolicy:string;defaultSandbox:string},accountId?:string) {
    row.phase="creating";this.save(row);
    const params={cwd:project.rootPath,model:row.targetModel,approvalPolicy:project.defaultApprovalPolicy,sandbox:project.defaultSandbox,
      threadSource:"user",historyMode:"legacy",config:{model_reasoning_effort:row.targetReasoningEffort??"medium"}};
    const result=accountId&&isAccountPoolBridge(this.bridge)?await this.bridge.startThreadOnAccount(accountId,params):await this.bridge.request("thread/start",params);
    row.targetThreadId=record(record(result).thread).id;
    if(!row.targetThreadId)throw new Error("Codex 未返回目标会话标识。");
    row.phase="importing";this.save(row);
    // No turn/start is issued. inject_items only appends local model history.
    let turnId = `migration-${row.id}-0`;
    for(const message of this.messages(row.id)) {
      if (message.role === "user") turnId = `migration-${row.id}-${row.importedCount}`;
      await this.bridge.request("thread/inject_items",{threadId:row.targetThreadId,items:[{type:"message",role:message.role,
        // Native injection updates prompt history, not thread/read's turns.
        // Keep web pagination/search aware of these historical messages too.
        internal_chat_message_metadata_passthrough:{turn_id:turnId},
        content:[{type:message.role==="assistant"?"output_text":"input_text",text:message.text}]}]},60_000);
      row.importedCount++;this.save(row);
    }
    await this.bridge.request("thread/name/set",{threadId:row.targetThreadId,name:`${row.sourceName} · 迁移`});
    this.store.registerThreadOwner({threadId:row.targetThreadId,userId:row.userId,projectId:row.projectId,rootPath:project.rootPath,model:row.targetModel,reasoningEffort:row.targetReasoningEffort??"medium"});
  }
}

/** Runtime-specific tools, signatures and hidden reasoning are never replayed
 * as executable native operations in a different engine. Their visible data
 * is kept verbatim as quoted history; the original JSONL is archived too. */
export function portableCodexItem(p:Row):TransferMessage|null {
  if(p.type==="message") {
    const role=p.role==="assistant"?"assistant":"user";
    if(p.role!=="assistant"&&p.role!=="user")return null;
    const parts=Array.isArray(p.content)?p.content:[];
    const text=parts.map((part:Row)=>typeof part.text==="string"?part.text:`[历史附件记录]\n${JSON.stringify(part)}`).join("\n");
    return text?{role,text,sourceId:p.id}:null;
  }
  if(["function_call","custom_tool_call","web_search_call","image_generation_call","computer_call","local_shell_call"].includes(p.type))return{role:"assistant",text:`[历史工具调用，仅供参考，已执行过]\n${JSON.stringify(p)}`,sourceId:p.call_id??p.id};
  if(["function_call_output","custom_tool_call_output","computer_call_output"].includes(p.type))return{role:"user",text:`[历史工具结果，仅供参考]\n${typeof p.output==="string"?p.output:JSON.stringify(p.output??p)}`,sourceId:p.call_id??p.id};
  return null;
}
export function portableClaudeMessage(raw:Row):TransferMessage|null {
  const m=record(raw.message),parts=typeof m.content==="string"?[{type:"text",text:m.content}]:Array.isArray(m.content)?m.content:[];
  const text=parts.filter((p:Row)=>!["thinking","redacted_thinking"].includes(p.type)).map((p:Row)=>p.type==="text"?p.text:
    p.type==="tool_use"?`[历史工具调用，仅供参考，已执行过]\n${JSON.stringify(p)}`:
    p.type==="tool_result"?`[历史工具结果，仅供参考]\n${typeof p.content==="string"?p.content:JSON.stringify(p.content)}`:
    `[历史附件记录]\n${JSON.stringify(p)}`).join("\n");
  return text?{role:raw.type==="assistant"?"assistant":"user",text,sourceId:raw.uuid}:null;
}
