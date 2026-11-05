import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, PreToolUseHookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntime, type ClaudeQueryFactory } from "./claudeRuntime.js";
import { assertClaudeExecutionAllowed, claudeToolPolicyDenial, enforceClaudeToolPolicy, type ClaudeExecutionOrigin } from "./claudeExecutionPolicy.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture(factory: ClaudeQueryFactory) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-policy-")); directories.push(cwd);
  const runtime = new ClaudeRuntime({ userId: "alice", orgId: "org-a", executable: "/bin/true", workspaceRoot: cwd, verifiedModels: { "reclaude-sonnet": "sonnet" } }, factory);
  return { runtime, input: { userId: "alice", threadId: "t", turnId: "r", cwd, model: "reclaude-sonnet", prompt: "检查文件" } };
}

describe("ReClaude workflow restriction", () => {
  it("rejects workflow dispatch and explicit skill invocation before spawning Claude", async () => {
    const factory = vi.fn(); const { runtime, input } = fixture(factory);
    for (const change of [
      { executionOrigin: "workflow" as const },
      { skillNames: ["pdf", "superagent-workflow"] },
      { prompt: "/superagent-workflow implement this" },
      { prompt: "$pdf $superagent-workflow\nimplement this" },
      { prompt: "/workflow" }
    ]) await expect(runtime.runTurn({ ...input, ...change })).rejects.toMatchObject({ code: "workflow_disabled" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("allows ordinary automation and discussion or editing of workflow files", async () => {
    const factory = vi.fn(async () => ({ close() {}, async *[Symbol.asyncIterator]() {
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "session-a" } as SDKMessage;
    } }));
    const { runtime, input } = fixture(factory);
    for (const executionOrigin of ["interactive", "scheduled", "continuation", "batch"] as ClaudeExecutionOrigin[]) {
      await runtime.runTurn({ ...input, executionOrigin, prompt: "Explain this workflow and edit .github/workflows/test.yml" });
    }
    expect(factory).toHaveBeenCalledTimes(4);
    for (const [name, args] of [["Read", { file_path: "/repo/.github/workflows/test.yml" }], ["Bash", { command: "git status" }], ["Skill", { skill: "pdf" }], ["Task", { subagent_type: "Explore" }], ["mcp__schedule__create", {}]] as const) {
      expect(claudeToolPolicyDenial(name, args)).toBeNull();
    }
    expect(() => assertClaudeExecutionAllowed({ prompt: "hi", executionOrigin: "unknown" as ClaudeExecutionOrigin })).toThrow("未知");
  });

  it("denies workflow tools even if native permission settings would skip canUseTool", async () => {
    let options!: Options;
    const { runtime, input } = fixture(async (_, opts) => {
      options = opts;
      return { close() {}, async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", is_error: false, result: "ok" } as SDKMessage; } };
    });
    await runtime.runTurn(input);
    const hook = options.hooks!.PreToolUse![0].hooks[0];
    expect(hook).toBe(enforceClaudeToolPolicy);
    expect(JSON.parse(options.extraArgs!.settings as string).disableWorkflows).toBe(true);
    for (const [tool_name, tool_input] of [
      ["mcp__workflow__run", {}], ["mcp__functions__runWorkflow", {}], ["WorkflowRun", {}],
      ["Skill", { skill: "plugin:superagent-workflow" }], ["Skill", { skill: "WORKFLOW" }],
      ["SlashCommand", { command: "/workflow run" }], ["Task", { subagent_type: "workflow-orchestrator" }],
      ["Read", { file_path: "/config/skills/superagent-workflow/SKILL.md" }]
    ] as const) {
      const event: PreToolUseHookInput = { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "/tmp/t", cwd: input.cwd, tool_name, tool_input, tool_use_id: "tool-a" };
      await expect(hook(event, "tool-a", { signal: new AbortController().signal })).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    }
  });

  it("does not offer a UI approval that could override a policy denial", async () => {
    let decision: unknown;
    const { runtime, input } = fixture(async (_, options) => ({ close() {}, async *[Symbol.asyncIterator]() {
      decision = await options.canUseTool!("Skill", { skill: "superagent-workflow" }, { signal: new AbortController().signal, toolUseID: "tool-a" });
      yield { type: "result", subtype: "success", is_error: false, result: "ok" } as SDKMessage;
    } }));
    const approval = vi.fn(); runtime.on("serverRequest", approval);
    await runtime.runTurn(input);
    expect(decision).toMatchObject({ behavior: "deny" });
    expect(approval).not.toHaveBeenCalled();
  });
});
