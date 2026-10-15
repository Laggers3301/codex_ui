import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Browser, Terminal, FileCode, MousePointer2, RotateCw, Clock } from "./PanelIcons";
import { WorkspaceIcon } from "./RightWorkspace";

describe("right workspace IconPark glyphs", () => {
  it("uses official 48-unit rounded paths with the sidebar stroke weight", () => {
    for (const Icon of [Browser, Terminal, FileCode, Clock]) {
      const html = renderToStaticMarkup(<Icon />);
      expect(html).toContain('viewBox="0 0 48 48"');
      expect(html).toContain('stroke-width="4"');
      expect(html).toContain('stroke-linecap="round"');
      expect(html).toContain('data-iconpark=');
      expect(html.match(/<svg\b/g)).toHaveLength(1);
      expect(html.startsWith("<svg")).toBe(true);
    }
  });
  it("keeps terminal and diff distinguishable and respects size/animation hooks", () => {
    expect(renderToStaticMarkup(<WorkspaceIcon name="terminal"/>)).toContain('data-iconpark="terminal"');
    expect(renderToStaticMarkup(<WorkspaceIcon name="diff"/>)).toContain('data-iconpark="file-code"');
    const html = renderToStaticMarkup(<RotateCw size={13} className="browserSpin"/>);
    expect(html).toContain('width="13"');
    expect(html).toContain('panelIcon browserSpin');
    expect(renderToStaticMarkup(<MousePointer2 fill="currentColor"/>)).toContain('fill="currentColor"');
  });
});
