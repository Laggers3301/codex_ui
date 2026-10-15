import { describe, expect, it } from "vitest";
import { skillReadSummary } from "./skillReadSummary";
import type { ThreadItem } from "./types";

const path = "/runtime/skills/.system/openai-docs/SKILL.md";
const item = (command: unknown, tool = "exec"): ThreadItem => ({ id: "read", type: "toolCall", tool, input: command });

describe("readable skill tool summaries", () => {
  it("recognizes the actual bash-wrapped read shown in the chat", () => {
    expect(skillReadSummary(item(`/bin/bash -lc "sed -n '1,280p' '${path}'"`))).toBe("读取 OpenAI Docs 技能");
  });
  it("accepts command objects, JSON and argv without changing execution", () => {
    for (const input of [{ cmd: `sed -n '1,260p' ${path}` }, JSON.stringify({ command: `head -100 ${path}` }), ["cat", path]]) {
      expect(skillReadSummary(item(input))).toBe("读取 OpenAI Docs 技能");
    }
  });
  it("supports a direct file read and a custom skill", () => {
    expect(skillReadSummary(item({ path: "/project/skills/custom-skill/SKILL.md" }, "filesystem.read_file"))).toBe("读取 custom-skill 技能");
    expect(skillReadSummary(item({ file_path: "C:\\skills\\openai-docs\\SKILL.md" }, "read_file"))).toBe("读取 OpenAI Docs 技能");
  });
  it("labels product-design routing skills with understandable names", () => {
    expect(skillReadSummary(item("cat '/plugins/product-design/hash/skills/index/SKILL.md'"))).toBe("读取 产品设计 · 入口 技能");
    expect(skillReadSummary(item("sed -n '1,280p' '/plugins/product-design/hash/skills/audit/SKILL.md'"))).toBe("读取 产品设计 · 体验审查 技能");
  });
  it("deduplicates batched reads and keeps file paths with spaces readable", () => {
    const command = `cat '${path}'\nhead -100 '${path}'\nsed -n '1,90p' '/tmp/my useful skill/SKILL.md'`;
    expect(skillReadSummary(item(command))).toBe("读取 OpenAI Docs、my useful skill 技能");
  });
  it("does not claim adoption, or mistake writes and incidental mentions for reads", () => {
    for (const command of [`echo 'sed -n ${path}'`, `rg SKILL.md /runtime/skills`, `sed -i 's/old/new/' ${path}`, `cat > ${path}`, `git diff -- ${path}`, "cat /skills/openai-docs/references/configuration.md"]) {
      expect(skillReadSummary(item(command))).toBeUndefined();
    }
    expect(skillReadSummary(item({ target: "/root", message: `read ${path}` }, "send_message"))).toBeUndefined();
  });
  it("only names the read file when another statement modifies a different skill", () => {
    expect(skillReadSummary(item(`cat ${path}; sed -i 's/old/new/' /skills/other/SKILL.md`))).toBe("读取 OpenAI Docs 技能");
  });
});
