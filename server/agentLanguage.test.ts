import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentLanguageInstructions, ensureDefaultAgentLanguage } from "./agentLanguage.js";

const roots: string[] = [];
const temporary = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-language-")); roots.push(directory); return directory; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("native default response language", () => {
  it("installs the same default for GPT and API runtimes without changing credentials or model config", () => {
    for (const kind of ["gpt", "ark", "mimo"]) {
      const root = temporary();
      fs.writeFileSync(path.join(root, "config.toml"), `model_provider = "${kind}"\n`);
      fs.writeFileSync(path.join(root, "auth.json"), "fixture credentials");
      const result = ensureDefaultAgentLanguage(root);
      expect(result.changed).toBe(true);
      expect(fs.readFileSync(result.path, "utf8")).toContain(defaultAgentLanguageInstructions);
      expect(fs.readFileSync(path.join(root, "config.toml"), "utf8")).toBe(`model_provider = "${kind}"\n`);
      expect(fs.readFileSync(path.join(root, "auth.json"), "utf8")).toBe("fixture credentials");
    }
  });

  it("preserves existing instructions byte-for-byte, prepends the default and does not rewrite it repeatedly", () => {
    const root = temporary();
    const file = path.join(root, "AGENTS.md");
    const existing = "# Existing safety rules\n\n- Keep all user data private.\n";
    fs.writeFileSync(file, existing, { mode: 0o640 });
    expect(ensureDefaultAgentLanguage(root).changed).toBe(true);
    const installed = fs.readFileSync(file, "utf8");
    expect(installed.endsWith(existing)).toBe(true);
    expect(installed.startsWith("<!-- codex-web:response-language:start -->")).toBe(true);
    expect(ensureDefaultAgentLanguage(root).changed).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(installed);
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it("honors the native non-empty global override instead of writing an ignored file", () => {
    const root = temporary();
    const file = path.join(root, "AGENTS.override.md");
    fs.writeFileSync(file, "# Active override\n");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Inactive base\n");
    expect(ensureDefaultAgentLanguage(root).path).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toContain(defaultAgentLanguageInstructions);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("# Inactive base\n");
  });

  it("keeps the explicit language exception and covers no-history subagents without translating raw tools", () => {
    expect(defaultAgentLanguageInstructions).toContain("用户明确指定其他语言");
    expect(defaultAgentLanguageInstructions).toContain("fresh/no-history forks");
    expect(defaultAgentLanguageInstructions).toContain("原始工具日志保留原样");
    expect(defaultAgentLanguageInstructions).toContain("An English task description is not a request for an English reply");
  });

  it("does not replace a user's linked instructions file", () => {
    const root = temporary();
    const source = path.join(root, "shared.md");
    fs.writeFileSync(source, "# Shared rules");
    fs.symlinkSync(source, path.join(root, "AGENTS.md"));
    expect(() => ensureDefaultAgentLanguage(root)).toThrow("regular file");
    expect(fs.readFileSync(source, "utf8")).toBe("# Shared rules");
  });

  it("bounds delegated context without silently overriding an explicit full-history request", () => {
    expect(defaultAgentLanguageInstructions).toContain('fork_turns="none"');
    expect(defaultAgentLanguageInstructions).toContain('不得直接用 fork_turns="all"');
    expect(defaultAgentLanguageInstructions).toContain("用户明确要求完整继承");
    expect(defaultAgentLanguageInstructions).toContain("不代表运行时已硬性阻止");
    expect(defaultAgentLanguageInstructions).toContain("不要因创建子代理长时间未返回而重复创建");
  });
});
