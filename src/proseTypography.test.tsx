import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { rehypeLatinApostrophes } from "./proseTypography";
import { createRevealPass, emptyRevealSnapshot } from "./streamReveal";
import { trimCodeTerminalLineFeed } from "./codeBlockText";

const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: [rehypeLatinApostrophes] }, text));
describe("Latin-word apostrophe typography", () => {
  it("preserves the exact characters and changes only internal Latin apostrophes", () => {
    const html = render("中文“We’re cooked”，don’t / l’été / we‘re / café’s。‘hello’ 中文’中文 x’ y; ；");
    expect(html.match(/class="latinWordApostrophe"/g)).toHaveLength(5);
    expect(html.replace(/<[^>]+>/g, "")).toContain("中文“We’re cooked”，don’t / l’été / we‘re / café’s。‘hello’ 中文’中文 x’ y; ；");
  });
  it("formats inline and fenced code without changing their source text", () => {
    const html = render("`We’re 中文‘引用’`\n\n```txt\nWe’re 中文‘引用’\n```");
    expect(html.match(/class="latinWordApostrophe"/g)).toHaveLength(2);
    expect(html).toContain('<code>We<span class="latinWordApostrophe">’</span>re 中文‘引用’</code>');
    expect(html).toContain('<pre><code class="language-txt">We<span class="latinWordApostrophe">’</span>re 中文‘引用’\n</code></pre>');
    expect(html.replace(/<[^>]+>/g, "")).toBe("We’re 中文‘引用’\nWe’re 中文‘引用’\n");
  });
  it("does not join words across paragraphs or code boundaries", () => {
    expect(render("We\n\n’re\n\nWe`x`’re")).not.toContain("latinWordApostrophe");
  });
  it("does not restore the phantom final code line when typography adds spans", () => {
    const children = ["We", createElement("span", { className: "latinWordApostrophe", key: "apostrophe" }, "’"), "re\n\n"];
    const html = renderToStaticMarkup(createElement("code", null, trimCodeTerminalLineFeed(children)));
    expect(html.replace(/<[^>]+>/g, "")).toBe("We’re\n");
    expect(trimCodeTerminalLineFeed("a\n")).toBe("a");
    expect(trimCodeTerminalLineFeed("a")).toBe("a");
  });
  it("works across emphasis and streaming spans without losing reveal metadata", () => {
    expect(render("**We**’re")).toContain('class="latinWordApostrophe"');
    const source = "We’re cooked";
    const previous = createRevealPass(emptyRevealSnapshot(), "We", 1000);
    renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: [previous.plugin] }, "We"));
    const pass = createRevealPass(previous.snapshot, source, 1100);
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: [pass.plugin, rehypeLatinApostrophes] }, source));
    expect(html).toContain("data-stream-start");
    expect(html.match(/class="latinWordApostrophe"/g)).toHaveLength(1);
    expect(html.replace(/<[^>]+>/g, "")).toBe(source);
  });
});
