import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { CanUseTool, Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_NOT_CONNECTED, isReclaudeModel } from "../shared/agentRuntime.js";
import { AppError } from "./appErrors.js";
import { ClaudeStreamAdapter } from "./claudeStreamAdapter.js";
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
}
export type ClaudeQuery = AsyncIterable<SDKMessage> & { close(): void };
export type ClaudeQueryFactory = (prompt: string, options: Options) => Promise<ClaudeQuery>;
const nativeQuery: ClaudeQueryFactory = async (prompt, options) => {
  const require = createRequire(new URL("../integrations/claude-session-tools/package.json", import.meta.url));
  const { query } = await import(require.resolve("@anthropic-ai/claude-agent-sdk"));
  // Tool permission callbacks require streaming input even for a single prompt.
  const input = (async function* () { yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" }; })();
  const stream = query({ prompt: input, options });
  return {
    [Symbol.asyncIterator]: () => stream,
    close: () => { options.abortController?.abort(); void stream.return(undefined).catch(() => {}); }
  };
};
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
  private active = new Map<string, { controller: AbortController; query?: ClaudeQuery; stopReason?: string | AppError }>();
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
    const state: { controller: AbortController; query?: ClaudeQuery; stopReason?: string | AppError } = { controller };
    this.active.set(input.threadId, state);
    const adapter = new ClaudeStreamAdapter(input.threadId, input.turnId, event => this.emit("notification", event));
    const canUseTool: CanUseTool = (name, original, context) => {
      const policyDenial = claudeToolPolicyDenial(name, original);
      if (policyDenial) return Promise.resolve({ behavior: "deny", message: policyDenial });
      if (controller.signal.aborted || context.signal.aborted) return Promise.resolve({ behavior: "deny", message: "本轮已取消。" });
      // Never permit the UI to replace the input or grant broader permissions.
      const toolInput = structuredClone(original);
      const question = name === "AskUserQuestion";
      const toolUseId=context.toolUseID;
      const questions=question?claudeQuestions(toolInput,toolUseId):[];
      if(question&&(!questions.length||questions.some(q=>typeof q.question!=="string"||!q.question.trim()))) {
        return Promise.resolve({behavior:"deny",message:"提问格式不完整，请重新生成问题。"});
      }
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
    try {
      const env = { ...process.env };
      // The bound wrapper supplies Claude auth. Do not forward another provider's
      // backend credentials (or an unrelated inherited Anthropic login) to tools.
      for (const key of Object.keys(env)) if (/^(?:CODEX_WEB_|OPENAI_|ARK_|MIMO_|ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL)$)/.test(key)) delete env[key];
      state.query = await this.factory(input.prompt, {
        cwd, model: nativeModel,
        ...(input.effort?{effort:input.effort}:{}),
        pathToClaudeCodeExecutable: binding.executable,
        env: { ...env, RECLAUDE_ORG: binding.orgId, CLAUDE_CODE_DISABLE_WORKFLOWS: "1", ...(binding.configRoot ? { CLAUDE_CONFIG_DIR: binding.configRoot } : {}) },
        abortController: controller,
        permissionMode: input.collaborationMode === "plan" ? "plan" : "default",
        canUseTool,
        hooks: { PreToolUse: [{ hooks: [enforceClaudeToolPolicy] }] },
        includePartialMessages: true,
        // Preserve Claude Code's native tools, skills, CLAUDE.md and MCP config.
        systemPrompt: { type: "preset", preset: "claude_code", append: CLAUDE_EXECUTION_INSTRUCTIONS },
        tools: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        ...(input.resumeSessionId ? { resume: input.resumeSessionId, forkSession: input.forkSession ?? false }
          : this.sessions.has(input.threadId) ? { resume: this.sessions.get(input.threadId) } : {}),
        extraArgs: {
          settings: JSON.stringify({ disableWorkflows: true }),
          ...(input.nativeSessionId && (!input.resumeSessionId || input.forkSession) ? { "session-id": input.nativeSessionId } : {})
        }
      });
      if (controller.signal.aborted) { adapter.finish("interrupted", state.stopReason); return; }
      for await (const message of state.query) {
        if (controller.signal.aborted) break;
        if ((message as {type:string}).type === "rate_limit_event") {
          this.emit("rateLimit", message);
          if (controller.signal.aborted) break;
        }
        if (message.type === "assistant") this.emit("nativeCheckpoint", { messageId: message.uuid });
        adapter.accept(message);
        if (adapter.sessionId) {
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
      this.active.delete(input.threadId);
    }
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
