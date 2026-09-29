import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it } from "vitest";
import { normalizeGfmTableBoundaries, normalizeMathMarkdown, stripInterruptArtifacts } from "./markdown";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, normalizeGfmTableBoundaries(markdown))
  );
}

function renderMathMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, [remarkMath, { singleDollarTextMath: true }]],
      rehypePlugins: [[rehypeKatex, { throwOnError: false, trust: false }]]
    }, normalizeMathMarkdown(markdown))
  );
}

describe("normalizeMathMarkdown", () => {
  it("keeps display math nested in a list without consuming later prose", () => {
    const markdown = [
      "- **AbsRel**",
      String.raw`  \[`,
      String.raw`  \mathrm{AbsRel}=\frac{1}{N}\sum_i e_i`,
      String.raw`  \]`,
      "",
      "  公式后的中文正文。",
      "",
      String.raw`  \[`,
      String.raw`  e_i=|d_i-\hat d_i|`,
      String.raw`  \]`
    ].join("\n");

    const normalized = normalizeMathMarkdown(markdown);
    expect(normalized).toContain(String.raw`  $$
  \mathrm{AbsRel}`);
    expect(normalized).toContain("\n  $$\n\n  公式后的中文正文。");

    const html = renderMathMarkdown(markdown);
    expect(html.match(/class=\"katex-display\"/g)).toHaveLength(2);
    expect(html).toContain("公式后的中文正文。");
    expect(html.indexOf("公式后的中文正文。")).toBeLessThan(html.lastIndexOf("katex-display"));
  });

  it("normalizes inline math but preserves code and incomplete streamed math", () => {
    expect(normalizeMathMarkdown("值为 \\(x+1\\)，代码 `\\(x\\)`。"))
      .toBe("值为 $x+1$，代码 `\\(x\\)`。");
    expect(normalizeMathMarkdown("- 生成中\n" + String.raw`  \[
  x + y`))
      .toBe("- 生成中\n" + String.raw`  \[
  x + y`);
    expect(normalizeMathMarkdown("```latex\n" + String.raw`\[x\]` + "\n```"))
      .toBe("```latex\n" + String.raw`\[x\]` + "\n```");
  });
});

describe("normalizeGfmTableBoundaries", () => {
  it("renders a table emitted immediately after prose", () => {
    const markdown = [
      "典型诊断规则：",
      "| 残差现象 | 优先调整 |",
      "|---|---|",
      "| 两条机械臂同向偏移 | 相机外参 |"
    ].join("\n");

    const normalized = normalizeGfmTableBoundaries(markdown);
    expect(normalized).toContain("典型诊断规则：\n\n| 残差现象 | 优先调整 |");
    expect(renderMarkdown(markdown)).toContain("<table>");
  });

  it("leaves an already separated table unchanged", () => {
    const markdown = "说明：\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(normalizeGfmTableBoundaries(markdown)).toBe(markdown);
  });

  it("does not rewrite table-like text inside fenced code", () => {
    const markdown = "```md\n说明：\n| A | B |\n| --- | --- |\n```";
    expect(normalizeGfmTableBoundaries(markdown)).toBe(markdown);
  });

  it("does not change ordinary prose containing pipes", () => {
    const markdown = "文字在前\nA | B\n下一行不是分隔线";
    expect(normalizeGfmTableBoundaries(markdown)).toBe(markdown);
  });

  it("moves prose after a table back into the document body", () => {
    const markdown = [
      "| 残差现象 | 优先调整 |",
      "|---|---|",
      "| 腕部偏移 | tool roll |",
      "[Eureka](https://example.com) 是后续正文。",
      "每次 Agent 修改后必须：",
      "",
      "- 在优化帧上改善"
    ].join("\n");

    const normalized = normalizeGfmTableBoundaries(markdown);
    expect(normalized).toContain("| 腕部偏移 | tool roll |\n\n[Eureka]");
    const html = renderMarkdown(markdown);
    expect(html.indexOf("Eureka")).toBeGreaterThan(html.indexOf("</table>"));
    expect(html).toContain("<p><a href=\"https://example.com\">Eureka</a> 是后续正文。\n每次 Agent 修改后必须：</p>");
  });

  it("preserves semantic blank lines while removing interrupt markers", () => {
    const markdown = "正文\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n后续正文\n<turn_aborted>";
    expect(stripInterruptArtifacts(markdown)).toBe(
      "正文\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n后续正文"
    );
  });

  it("removes unresolved internal citation tokens without touching Markdown links", () => {
    const markdown = "结论 citeturn460151view0，参考 [官方文档](https://example.com)。\n多来源 citeturn1search0turn1search1";
    expect(stripInterruptArtifacts(markdown)).toBe(
      "结论，参考 [官方文档](https://example.com)。\n多来源"
    );
  });
});
