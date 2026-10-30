import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CanUseTool, Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_NOT_CONNECTED, isReclaudeModel } from "../shared/agentRuntime.js";
import { AppError } from "./appErrors.js";
import { ClaudeStreamAdapter } from "./claudeStreamAdapter.js";

/** Supplied by a trusted, server-side binding registry after live verification.
 * This stage deliberately has no HTTP endpoint or environment switch that can
 * create one. Never construct this object from a browser request body. */
export interface VerifiedClaudeBinding {
  userId: string;
  orgId: string;
  executable: string;
  workspaceRoot: string;
  verifiedModels: Readonly<Record<string, string>>;
}
export interface ClaudeTurnInput {
  userId: string;
  threadId: string;
  turnId: string;
  cwd: string;
  model: string;
  prompt: string;
}
export type ClaudeQuery = AsyncIterable<SDKMessage> & { close(): void };
export type ClaudeQueryFactory = (prompt: string, options: Options) => Promise<ClaudeQuery>;
const nativeQuery: ClaudeQueryFactory = async (prompt, options) => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const stream = query({ prompt, options });
  return {
    [Symbol.asyncIterator]: () => stream,
    close: () => { options.abortController?.abort(); void stream.return(undefined).catch(() => {}); }
  };
};
interface PendingApproval {
  userId: string;
  threadId: string;
  settle(decision: "accept" | "decline"): void;
}

/** Native Claude execution adapter; the pre-auth application never activates
 * it. Tests inject an SDK fixture, so no credentials, CLI or model are used. */
export class ClaudeRuntime extends EventEmitter {
  private active = new Map<string, { controller: AbortController; query?: ClaudeQuery }>();
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
    const state: { controller: AbortController; query?: ClaudeQuery } = { controller };
    this.active.set(input.threadId, state);
    const adapter = new ClaudeStreamAdapter(input.threadId, input.turnId, event => this.emit("notification", event));
    const canUseTool: CanUseTool = (name, original, context) => {
      if (controller.signal.aborted || context.signal.aborted) return Promise.resolve({ behavior: "deny", message: "本轮已取消。" });
      // Never permit the UI to replace the input or grant broader permissions.
      const toolInput = structuredClone(original);
      const id = `claude-approval:${randomUUID()}`;
      return new Promise<PermissionResult>(resolve => {
        let settled = false;
        const settle = (decision: "accept" | "decline") => {
          if (settled) return;
          settled = true;
          this.pending.delete(id);
          controller.signal.removeEventListener("abort", aborted);
          context.signal.removeEventListener("abort", aborted);
          resolve(decision === "accept"
            ? { behavior: "allow", updatedInput: toolInput }
            : { behavior: "deny", message: "用户未批准此操作。" });
        };
        const aborted = () => settle("decline");
        this.pending.set(id, { userId: input.userId, threadId: input.threadId, settle });
        controller.signal.addEventListener("abort", aborted, { once: true });
        context.signal.addEventListener("abort", aborted, { once: true });
        this.emit("serverRequest", { id, method: "item/claudeTool/requestApproval", params: {
          threadId: input.threadId, turnId: input.turnId,
          toolName: name, toolInput: structuredClone(toolInput),
          reason: context.decisionReason ?? "Claude 请求执行此操作。",
          availableDecisions: ["decline", "accept"]
        } });
      });
    };
    adapter.start();
    try {
      state.query = await this.factory(input.prompt, {
        cwd, model: nativeModel,
        pathToClaudeCodeExecutable: binding.executable,
        env: { ...process.env, RECLAUDE_ORG: binding.orgId },
        abortController: controller,
        permissionMode: "default",
        canUseTool,
        includePartialMessages: true,
        // Preserve Claude Code's native tools, skills, CLAUDE.md and MCP config.
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        ...(this.sessions.has(input.threadId) ? { resume: this.sessions.get(input.threadId) } : {})
      });
      if (controller.signal.aborted) { adapter.finish("interrupted"); return; }
      for await (const message of state.query) {
        if (controller.signal.aborted) break;
        adapter.accept(message);
        if (adapter.sessionId) this.sessions.set(input.threadId, adapter.sessionId);
        if (adapter.finished) break;
      }
      if (!adapter.finished) adapter.finish(controller.signal.aborted ? "interrupted" : "failed",
        controller.signal.aborted ? undefined : "Claude 输出在完成标记之前中断，结果尚未确认。");
    } catch (error) {
      adapter.finish(controller.signal.aborted ? "interrupted" : "failed", controller.signal.aborted ? undefined : String(error));
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
    if (!pending || pending.userId !== userId) throw new Error("批准请求不存在或已结束。");
    if (decision !== "accept" && decision !== "decline") throw new Error("Claude 仅支持批准本次操作或拒绝。");
    pending.settle(decision);
  }

  interrupt(userId: string, threadId: string): void {
    this.ownedBinding(userId);
    const state = this.active.get(threadId);
    state?.controller.abort();
    state?.query?.close();
  }
}
