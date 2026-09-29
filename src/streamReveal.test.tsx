import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";
import { describe, expect, it } from "vitest";
import { createRevealPass, emptyRevealSnapshot, type RevealSnapshot } from "./streamReveal";
import { normalizeGfmTableBoundaries } from "./markdown";

function render(source: string, previous = emptyRevealSnapshot(), now = 1000) {
  const markdown = normalizeGfmTableBoundaries(remend(source, { linkMode: "text-only" }));
  const pass = createRevealPass(previous, source, now, markdown);
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm], rehypePlugins: [pass.plugin]
  }, markdown));
  return { html, snapshot: pass.snapshot };
}

describe("source-anchored streaming reveal", () => {
  it("keeps initial snapshots and conversation remounts opaque", () => {
    expect(render("历史\n\n- **列表** `代码`").html).not.toContain("data-stream-start");
  });
  it.each([
    ["前文。\n\n- 第一项\n- 第二项", "\n\n- 第三项"],
    ["前文。\n\n- 第一项\n\n- 第二项", "继续"],
    ["- 状态：`enabled: false`\n- 套餐：**Free**", "\n\n- 额度：允许"],
    ["> 引用\n>\n> - 已有文字", "\n> - 新文字"],
    ["| A | B |\n|---|---|\n| 旧 | 文 |", "\n| 新 | 字 |"],
    ["说明\n| 旧 | 文 |", "\n|---|---|\n| 新 | 字 |"],
    ["旧 &amp; 文", "新增"],
    ["前文 **加粗", "** 新文"],
    ["前文 `代码", "` 新文"],
    ["已有 [链接](https://exam", "ple.com) 新增"]
  ])("never reanimates old text when Markdown nesting changes: %s", (old, delta) => {
    const previous = render(old).snapshot;
    const current = render(old + delta, previous, 2000);
    for (const offset of current.snapshot.active.keys()) expect(offset).toBeGreaterThanOrEqual(old.length);
    const times = [...current.snapshot.active.entries()].sort((a,b) => a[0]-b[0]).map(([,time]) => time);
    expect(times).toEqual([...times].sort((a,b) => a-b));
    expect(current.html).not.toMatch(/data-stream-start[^>]*>套餐|data-stream-start[^>]*>Free/);
  });
  it("retains absolute animation starts through tight-to-loose list remounts", () => {
    const a = render("开头").snapshot;
    const b = render("开头\n\n- 第一项\n- 第二项", a, 2000).snapshot;
    const c = render(b.source + "\n\n- 第三项", b, 2040).snapshot;
    for (const [offset, start] of b.active) expect(c.active.get(offset)).toBe(start);
    const d = render(c.source + "继续", c, 5000).snapshot;
    for (const offset of d.active.keys()) expect(offset).toBeGreaterThanOrEqual(c.source.length);
  });
  it("is repeatable under repeated tree processing", () => {
    const prev = render("前文").snapshot;
    expect(render("前文追加", prev, 2000).snapshot).toEqual(render("前文追加", prev, 2000).snapshot);
  });
  it("does not animate fenced code or schedule an unbounded invisible backlog", () => {
    const previous: RevealSnapshot = { source: "前文", active: new Map(), nextStart: 99999 };
    const result = render("前文\n\n```js\nconst n = 1\n```\n\n" + "新增文字".repeat(300), previous, 2000);
    expect(result.html).toContain('<code class="language-js">const n = 1');
    expect(Math.max(...result.snapshot.active.values())).toBeLessThanOrEqual(2320);
  });
});
