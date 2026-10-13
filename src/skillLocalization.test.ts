import { describe, expect, it } from "vitest";
import { localizedSkill, skillSection } from "./skillLocalization";

const display = (name: string) => ({
  name, displayName: "English display name", shortDescription: "English short description",
  description: "English detailed instructions",
});
const addedNames = [
  "google-drive:google-docs", "google-drive:google-drive", "google-drive:google-drive-comments",
  "google-drive:google-sheets", "google-drive:google-slides", "lingbot-head-only-wrist-harness",
  "notion:notion-knowledge-capture", "notion:notion-meeting-intelligence",
  "notion:notion-research-documentation", "notion:notion-spec-to-implementation",
  "pages:maintain-space", "pages:manage-schedules", "pages:organize-space", "pages:write-page",
  "plugin-management:plugin-management", "remote-folders",
  "sites:sites-building", "sites:sites-hosting", "sites:sites-mcp", "sites:sites-preview-troubleshooting",
  "work-pets:create-pet", "work-pets:pets", "work-pets:update-pet",
];

describe("display-only skill localization", () => {
  it.each(addedNames)("localizes both name and description for %s", (name) => {
    const skill = Object.freeze(display(name));
    const copy = localizedSkill(skill);
    expect(copy.name).toMatch(/[\u4e00-\u9fff]/);
    expect(copy.description).toMatch(/[\u4e00-\u9fff]/);
    expect(skill).toEqual(display(name));
  });

  it("preserves established translations and sections", () => {
    expect(localizedSkill(display("latex-word-authoring")).name).toBe("LaTeX / Word 写作");
    expect(localizedSkill(display("build-web-data-visualization:data-visualization")).name).toBe("数据可视化");
    expect(skillSection("product-design:audit")).toBe("产品设计");
    expect(skillSection("latex-word-authoring")).toBe("文档写作");
  });

  it("does not pretend ChatGPT Work pets are the local web-pet feature", () => {
    for (const name of addedNames.filter(name => name.startsWith("work-pets:"))) {
      expect(localizedSkill(display(name)).description).toMatch(/ChatGPT|自定义宠物/);
    }
  });

  it("keeps unknown custom skills readable without inventing their purpose", () => {
    expect(localizedSkill(display("custom:tool"))).toEqual({
      name: "English display name", description: "English short description",
    });
    expect(localizedSkill({ name: "自定义工具", displayName: "", shortDescription: null, description: "" }))
      .toEqual({ name: "自定义工具", description: "Codex 扩展技能" });
  });
});
