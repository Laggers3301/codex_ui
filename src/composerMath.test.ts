// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { ComposerBlockMath, ComposerInlineMath, hasComposerMath } from "./composerMath";
import { normalizeMathMarkdown } from "./markdown";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));
function editorFor(content: string, math = true) {
  const editor = new Editor({ extensions: [StarterKit, Markdown, ...(math ? [
    ComposerInlineMath.configure({ katexOptions: { throwOnError: false } }),
    ComposerBlockMath.configure({ katexOptions: { throwOnError: false } }),
  ] : [])], content, contentType: "markdown" });
  editors.push(editor); return editor;
}
const formulas = (editor: Editor) => {
  const values: Array<{ type: string; latex: string }> = [];
  editor.state.doc.descendants(node => { if (/^(inlineMath|blockMath)$/.test(node.type.name)) values.push({ type: node.type.name, latex: node.attrs.latex }); });
  return values;
};

it.each([
  [String.raw`其中 $\theta$ 为参数`, "inlineMath", String.raw`\theta`],
  [String.raw`其中 \(\theta, \eta\) 为参数`, "inlineMath", String.raw`\theta, \eta`],
  ["$$\n\\xi=(\\theta,\\eta)\n$$", "blockMath", String.raw`\xi=(\theta,\eta)`],
  ["\\[\n\\xi=(\\theta,\\eta)\n\\]", "blockMath", String.raw`\xi=(\theta,\eta)`],
])("parses and round-trips %s", (source, type, latex) => {
  const editor = editorFor(source);
  expect(formulas(editor)).toEqual([{ type, latex }]);
  expect(editor.view.dom.querySelector(".katex")).not.toBeNull();
  for (let i = 0; i < 3; i++) editor.commands.setContent(editor.getMarkdown(), { contentType: "markdown" });
  expect(formulas(editor)).toEqual([{ type, latex }]);
});

it("parses a multiline posterior and preserves matrix row breaks through paste and serialization", () => {
  const latex = String.raw`\begin{aligned}\pi(\xi\mid D)&\propto p(\xi)\\ y&=\Sigma^{-1/2}\end{aligned}`;
  const editor = editorFor("");
  editor.commands.insertContent(`\\[\n${latex}\n\\]`, { contentType: "markdown" });
  expect(formulas(editor)).toEqual([{ type: "blockMath", latex }]);
  expect(formulas(editorFor(editor.getMarkdown()))).toEqual(formulas(editor));
});

it("recovers exactly one legacy Markdown escape layer without destroying LaTeX row breaks", () => {
  const source = String.raw`\[\begin{aligned}a&=\theta\\b&=\eta\end{aligned}\]`;
  const legacy = editorFor("", false);
  legacy.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: source }] }] });
  const escaped = legacy.getMarkdown();
  expect(escaped).toContain("\\\\\\[");
  expect(formulas(editorFor(escaped))).toEqual([{ type: "blockMath", latex: String.raw`\begin{aligned}a&=\theta\\b&=\eta\end{aligned}` }]);
  expect(normalizeMathMarkdown(escaped, true)).toBe(`$$\n${source.slice(2, -2)}\n$$`);
  expect(normalizeMathMarkdown(`\`${escaped}\``, true)).toBe(`\`${escaped}\``);
  expect(normalizeMathMarkdown(`\`\`\`latex\n${escaped}\n\`\`\``, true)).toBe(`\`\`\`latex\n${escaped}\n\`\`\``);
});

it("keeps inline code and fenced LaTeX literal and tolerates incomplete or invalid formulas", () => {
  const code = "`\\(x\\)`\n\n```latex\n\\[x\\]\n$$y$$\n```";
  const editor = editorFor(code);
  expect(formulas(editor)).toEqual([]);
  expect(editor.getText()).toContain(String.raw`\[x\]`);
  expect(formulas(editorFor(String.raw`\[unfinished`))).toEqual([]);
  expect(() => editorFor(String.raw`$\notacommand{$`)).not.toThrow();
  expect(hasComposerMath(String.raw`\[x\]`)).toBe(true);
  expect(hasComposerMath("普通文字")).toBe(false);
});
