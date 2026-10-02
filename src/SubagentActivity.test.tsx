import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubagentToolCard } from "./SubagentActivity";
import { subagentAvatarIdentity } from "./SubagentAvatar";

describe("collaboration message recipients", () => {
  it("renders the root as the main agent, without pretending delivery is a task status", () => {
    const html = renderToStaticMarkup(<SubagentToolCard item={{ id: "message", type: "toolCall", tool: "collaboration.send_message", input: { target: "/root", message: "gAAAA" + "A".repeat(200) } }} onOpenAgent={() => {}} />);
    expect(html).toContain("主代理");
    expect(html).toContain('title="/root"');
    expect(html).not.toContain("状态待确认");
    expect(html).not.toContain("gAAAA");
    expect(html).not.toContain("<button");
  });
  it("keeps actual child recipients navigable, not hardcoded to root", () => {
    const html = renderToStaticMarkup(<SubagentToolCard item={{ id: "message", type: "toolCall", tool: "send_message", input: { target: "child-id" } }} knownAgents={[{ id: "child-id", name: "/root/compiler", state: "running" }]} onOpenAgent={() => {}} />);
    expect(html).toContain("compiler");
    expect(html).toContain("<button");
    expect(html).not.toContain("主代理");
    expect(html).not.toContain("执行中");
  });
  it("never confuses the root icon with a child's decorative avatar", () => {
    for (const name of ["latex_docx_research", "document_compiler", "document_backend", "subagent_assets"]) {
      expect(subagentAvatarIdentity("/root").glyph).not.toBe(subagentAvatarIdentity(`/root/${name}`).glyph);
      expect(subagentAvatarIdentity(name)).toEqual(subagentAvatarIdentity(`/root/${name}`));
    }
  });
});
