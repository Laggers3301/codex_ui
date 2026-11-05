import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { AppError } from "./appErrors.js";

export const CLAUDE_WORKFLOW_DISABLED = "此 ReClaude 接入禁止 workflow 编排。普通对话、定时任务、批处理和自动续跑不受此限制。";

/** This is a server-owned policy, not a browser preference or an approval that
 * can be overridden by a user's saved Claude permissions. */
export const claudeExecutionPolicy = Object.freeze({ workflow: false, scheduled: true, continuation: true, batch: true });
export type ClaudeExecutionOrigin = "interactive" | "scheduled" | "continuation" | "batch" | "workflow";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Match entrypoint identifiers, not arbitrary prompt text. Users must still
 * be able to discuss workflows or edit a repository's .github/workflows. */
export function isWorkflowEntrypoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const name = value.normalize("NFKC").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return /(?:^|[^a-z0-9])work[-_ ]?flows?(?:$|[^a-z0-9])/.test(name) || name.includes("工作流");
}

function leadingInvocations(prompt: string): string[] {
  const prefix = prompt.match(/^\s*((?:[$/][\w.:-]+(?:[ \t]+|\r?\n|$))+)/)?.[1] ?? "";
  return [...prefix.matchAll(/[$/]([\w.:-]+)/g)].map(match => match[1]);
}

export function assertClaudeExecutionAllowed(input: {
  executionOrigin?: ClaudeExecutionOrigin;
  skillNames?: readonly string[];
  prompt: string;
}): void {
  if (input.executionOrigin === "workflow"
    || input.skillNames?.some(isWorkflowEntrypoint)
    || leadingInvocations(input.prompt).some(isWorkflowEntrypoint)) {
    throw new AppError("workflow_disabled", CLAUDE_WORKFLOW_DISABLED);
  }
  if (input.executionOrigin !== undefined && !["interactive", "scheduled", "continuation", "batch"].includes(input.executionOrigin)) {
    throw new AppError("unsupported_execution_origin", "未知的 Claude 执行来源。");
  }
}

export function claudeToolPolicyDenial(toolName: string, input: unknown): string | null {
  if (isWorkflowEntrypoint(toolName)) return CLAUDE_WORKFLOW_DISABLED;
  const args = record(input);
  const tool = toolName.toLowerCase();
  if ((tool === "skill" && isWorkflowEntrypoint(args.skill))
    || (tool === "slashcommand" && isWorkflowEntrypoint(String(args.command ?? "").trim().split(/\s/)[0]))
    || (["task", "agent"].includes(tool) && isWorkflowEntrypoint(args.subagent_type))) {
    return CLAUDE_WORKFLOW_DISABLED;
  }
  // Claude can load a skill by reading its instructions, without invoking the
  // Skill tool. Restrict that activation path, not ordinary workflow documents.
  if (tool === "read" && typeof args.file_path === "string") {
    const skill = args.file_path.replace(/\\/g, "/").match(/\/skills\/([^/]+)\/SKILL\.md$/i)?.[1];
    if (isWorkflowEntrypoint(skill)) return CLAUDE_WORKFLOW_DISABLED;
  }
  return null;
}

/** PreToolUse also runs for tools allowed by native settings, whereas
 * canUseTool alone is only consulted when Claude needs a permission decision. */
export const enforceClaudeToolPolicy: HookCallback = async input => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const reason = claudeToolPolicyDenial(input.tool_name, input.tool_input);
  return reason ? { hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason
  } } : {};
};

export const CLAUDE_EXECUTION_INSTRUCTIONS = "本接入禁止 workflow 编排：不得调用 workflow 类技能、工具或工作流代理，也不得通过 shell、脚本或其他工具间接启动它们。可以使用普通 Claude 工具与非 workflow 技能；定时任务、批处理、自动续跑仍然允许。";
