import { describe, expect, it } from "vitest";
import { applyThreadPresentation, inlineContentDisposition, mergeModelProfiles, orderGptByVersion, modelProfilesFromCatalog, sanitizeMcpServerStatus, sanitizeThreadPayloadForClient } from "./routes.js";

it("unions Ultra Fast account entitlements without advertising unsupported reasoning levels", () => {
  const catalog = { models: [{ slug: "gpt-6.2-sol", display_name: "GPT-6.2 Sol", visibility: "list", shell_type: "shell_command", supported_reasoning_levels: [{ effort: "low" }], service_tiers: [{ id: "ultrafast" }] }] };
  const merged = mergeModelProfiles([...modelProfilesFromCatalog(catalog, "pro-a"), ...modelProfilesFromCatalog(catalog, "pro-b")]);
  expect(merged).toHaveLength(1);
  expect(merged[0].ultrafastAccounts).toEqual(["pro-a", "pro-b"]);
});

describe("sanitizeMcpServerStatus", () => {
  it("returns only presentation status, never connector credentials or tool schemas", () => {
    const result = sanitizeMcpServerStatus({ data: [{
      name: "private-provider",
      pluginId: "provider@official",
      runtimeStatus: "connected",
      authStatus: "oAuth",
      accessToken: "secret-token",
      tools: { search: { inputSchema: { token: "secret-schema" } } }
    }] });
    expect(result.data).toEqual([{ name: "private-provider", pluginId: "provider@official", runtimeStatus: "connected", authStatus: "oAuth", toolCount: 1, toolNames: ["search"] }]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("inlineContentDisposition", () => {
  it("encodes non-ASCII filenames without putting invalid characters in the header", () => {
    const value = inlineContentDisposition('版式均衡版_v2_九页预览.png');

    expect(value).toBe(
      "inline; filename=\"______v2_____.png\"; filename*=UTF-8''%E7%89%88%E5%BC%8F%E5%9D%87%E8%A1%A1%E7%89%88_v2_%E4%B9%9D%E9%A1%B5%E9%A2%84%E8%A7%88.png"
    );
    expect([...value].every(character => character.charCodeAt(0) <= 0x7e)).toBe(true);
  });

  it("neutralizes quotes, backslashes, and control characters in the ASCII fallback", () => {
    const value = inlineContentDisposition("bad\"\\\r\nname.txt");

    expect(value).toContain('filename="bad____name.txt"');
    expect(value).not.toMatch(/[\r\n]/);
  });
});

describe("sanitizeThreadPayloadForClient", () => {
  it("removes an internal AGENTS prelude returned by app-server", () => {
    const payload = {
      thread: {
        turns: [{
          id: "turn-1",
          items: [
            { id: "internal", type: "userMessage", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\ninternal\n</INSTRUCTIONS>\n<environment_context>\n<context/>\n</environment_context>" }] },
            { id: "prompt", type: "userMessage", content: [{ type: "input_text", text: "用户问题" }] }
          ]
        }]
      }
    };

    sanitizeThreadPayloadForClient(payload);

    expect(payload.thread.turns[0].items.map((item) => item.id)).toEqual(["prompt"]);
  });

  it("hides runtime skill instructions and AGENTS notes without hiding a normal user prompt", () => {
    const payload = { thread: { turns: [{ id: "turn-skill", items: [
      { id: "agents", type: "userMessage", role: "user", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>runtime notes</INSTRUCTIONS>" },
      { id: "skill", type: "userMessage", role: "user", text: "<skill><name>pdf</name><path>/runtime/skills/pdf/SKILL.md</path>---\n# PDF" },
      { id: "prompt", type: "userMessage", role: "user", text: "请阅读 PDF" }
    ] }] } };
    sanitizeThreadPayloadForClient(payload);
    expect(payload.thread.turns[0].items.map((item) => item.id)).toEqual(["prompt"]);
  });

  it("hides context-recovery steering and the generic failed handoff answer", () => {
    const payload = {
      thread: {
        turns: [{
          id: "turn-compact",
          items: [
            { id: "prompt", type: "userMessage", role: "user", text: "继续重命名项目" },
            { id: "compact", type: "toolCall", tool: "contextCompaction" },
            { id: "recovery", type: "userMessage", role: "user", text: "<codex_internal_context_recovery>\nread notes" },
            { id: "lost", type: "agentMessage", role: "assistant", text: "Ready—what would you like me to work on?" },
            { id: "continued", type: "agentMessage", role: "assistant", text: "已恢复检查点并继续重命名。" }
          ]
        }]
      }
    };

    sanitizeThreadPayloadForClient(payload);

    expect(payload.thread.turns[0].items.map((item) => item.id)).toEqual(["prompt", "continued"]);
  });

  it("does not hide a similar assistant answer when no compaction occurred", () => {
    const payload = { thread: { turns: [{ id: "normal", items: [
      { id: "answer", type: "agentMessage", role: "assistant", text: "What would you like me to work on?" }
    ] }] } };
    sanitizeThreadPayloadForClient(payload);
    expect(payload.thread.turns[0].items).toHaveLength(1);
  });

  it("hides internal continuation messages from both text and content history", () => {
    const payload = { thread: { turns: [{ id: "continuation", items: [
      { id: "prompt", type: "userMessage", role: "user", text: "修复这个问题" },
      { id: "recovery-text", type: "userMessage", role: "user", text: "  <codex_internal_continuation_recovery>\nContinue immediately" },
      { id: "recovery-content", type: "userMessage", content: [{ type: "input_text", text: "<codex_internal_continuation_recovery>\nContinue immediately" }] },
      { id: "answer", type: "agentMessage", role: "assistant", text: "问题修复了。" }
    ] }] } };
    sanitizeThreadPayloadForClient(payload);
    expect(payload.thread.turns[0].items.map((item) => item.id)).toEqual(["prompt", "answer"]);
  });
});

describe("modelProfilesFromCatalog", () => {
  it("merges Terra from a newer pool catalog without duplicates or unsupported UI efforts", () => {
    const model=(slug:string,priority:number,levels=['low','medium','high','xhigh','max','ultra'])=>({slug,display_name:slug,visibility:'list',shell_type:'unified_exec',priority,supported_reasoning_levels:levels.map(effort=>({effort}))});
    const old=modelProfilesFromCatalog({models:[model('gpt-6.1-sol',1),model('gpt-6-sol',2)]});
    const next=modelProfilesFromCatalog({models:[model('gpt-6.1-sol',1),model('gpt-6.1-terra',3)]});
    const merged=mergeModelProfiles([...old,...next,...next]);
    expect(merged.filter(m=>m.model==='gpt-6.1-terra').map(m=>m.effort)).toEqual(['max','xhigh','high','medium','low']);
    expect(new Set(merged.map(m=>m.id)).size).toBe(merged.length);
    expect([...new Set(merged.map(m=>m.model))]).toEqual(['gpt-6.1-sol','gpt-6.1-terra','gpt-6-sol']);
    expect(merged.some(m=>m.effort==='ultra')).toBe(false);
  });
  it("includes both legacy shell_command and current unified_exec models", () => {
    const profiles = modelProfilesFromCatalog({
      models: [
        {
          slug: "gpt-6-astra",
          display_name: "GPT-6 Astra",
          visibility: "list",
          shell_type: "unified_exec",
          priority: 0,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }]
        },
        {
          slug: "gpt-6.1-sol",
          display_name: "GPT-6.1-Sol",
          visibility: "list",
          shell_type: "unified_exec",
          priority: 1,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }]
        },
        {
          slug: "gpt-5.6-sol",
          display_name: "GPT-5.6 Sol",
          visibility: "list",
          shell_type: "shell_command",
          priority: 4,
          supported_reasoning_levels: [{ effort: "high" }]
        },
        {
          slug: "gpt-6-sol",
          display_name: "GPT-6 Sol",
          visibility: "list",
          shell_type: "unified_exec",
          priority: 2,
          supported_reasoning_levels: [{ effort: "max" }]
        },
        {
          slug: "gpt-6-luna",
          display_name: "GPT-6 Luna",
          visibility: "list",
          shell_type: "unified_exec",
          priority: 3,
          supported_reasoning_levels: [{ effort: "medium" }]
        },
        {
          slug: "hidden-model",
          display_name: "Hidden",
          visibility: "hide",
          shell_type: "unified_exec",
          priority: 2,
          supported_reasoning_levels: [{ effort: "low" }]
        },
        {
          slug: "gpt-5.4-mini",
          display_name: "GPT-5.4 Mini",
          visibility: "list",
          shell_type: "unified_exec",
          priority: 3,
          supported_reasoning_levels: [{ effort: "high" }]
        },
        {
          slug: "gpt-5.3-codex-spark",
          display_name: "GPT-5.3-Codex-Spark",
          visibility: "list",
          shell_type: "unified_exec",
          priority: 4,
          supported_reasoning_levels: [{ effort: "medium" }]
        }
      ]
    });

    expect(profiles.map((profile) => profile.id)).toEqual([
      // Newest version first, whatever the catalog's priority numbers say.
      "gpt-6.1-sol:max",
      "gpt-6.1-sol:low",
      "gpt-6-astra:low",
      "gpt-6-sol:max",
      "gpt-6-luna:medium",
      "gpt-5.6-sol:high"
    ]);
    expect(profiles.some((profile) => profile.effort === "ultra")).toBe(false);
  });
});

describe("applyThreadPresentation", () => {
  it("attaches the saved model profile to persisted-history thread payloads", () => {
    const thread = applyThreadPresentation(
      { id: "thread-1", turns: [] },
      {
        threadId: "thread-1",
        pinned: true,
        manualOrder: 0,
        model: "gpt-6-astra",
        reasoningEffort: "medium",
        serviceTier: null,
        displayName: "Astra thread"
      },
      { model: "gpt-6-astra", reasoningEffort: "medium" }
    );

    expect(thread).toMatchObject({
      id: "thread-1",
      pinned: true,
      configuredModel: "gpt-6-astra",
      configuredReasoningEffort: "medium"
    });
  });
});

describe("GPT model order", () => {
  it("lists the newest version first and the most capable tier first inside a version, leaving other models in place", () => {
    const names = ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.2-astra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
    const input = [...names.flatMap(model => ["xhigh", "high"].map(effort => ({ model, effort }))), { model: "claude-x", effort: "high" }, { model: "doubao-y", effort: "high" }];
    const out = orderGptByVersion(input);
    expect([...new Set(out.map(entry => entry.model))]).toEqual(["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "claude-x", "doubao-y"]);
    expect(out.filter(entry => entry.model === "gpt-6.2-astra").map(entry => entry.effort)).toEqual(["xhigh", "high"]);
    expect(out).toHaveLength(input.length);
    expect(orderGptByVersion([{ model: "gpt-6.2-astra" }, { model: "gpt-6.2-sol" }]).map(entry => entry.model)).toEqual(["gpt-6.2-astra", "gpt-6.2-sol"]);
  });
});
