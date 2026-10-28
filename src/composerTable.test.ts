// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { describe, expect, it } from "vitest";
import { clipboardTable, ComposerTableKit } from "./composerTable";

const makeEditor = (content = "", contentType: "markdown" | "html" = "markdown") => new Editor({
  extensions: [StarterKit, ComposerTableKit, Markdown], content, contentType
});
describe("editable composer tables", () => {
  it("renders Markdown as a real table and preserves rows on serialization", () => {
    const editor = makeEditor("| 姓名 | 进度 |\n| --- | --- |\n| 毅钧 | 完成 |");
    expect(editor.getHTML()).toContain("<table");
    expect(editor.getMarkdown()).toContain("毅钧");
    expect(editor.getJSON().content?.[0].content).toHaveLength(2);
    editor.destroy();
  });
  it("keeps HTML clipboard cells, surrounding prose, and no executable nodes", () => {
    const editor = makeEditor('<p>说明</p><table><tr><th>项目</th><th>进度</th></tr><tr><td>A</td><td><b>完成</b></td></tr></table><script>window.evil=1</script><p>结尾</p>', "html");
    expect(editor.getMarkdown()).toMatch(/说明[\s\S]*\|.*项目[\s\S]*完成[\s\S]*结尾/);
    expect(editor.getHTML()).not.toContain("<script");
    editor.destroy();
  });
  it("accepts TSV, quoted multiline cells, tabs in quotes, empty cells, and CRLF", () => {
    const table = clipboardTable('姓名\t说明\t空列\r\n毅钧\t"第一行\n第二行\t引号"\t\r\n');
    expect(table?.content).toHaveLength(2);
    expect(table?.content?.[1].content).toHaveLength(3);
    const editor = makeEditor();
    editor.commands.insertContent(table!);
    expect(editor.getMarkdown()).toContain("毅钧");
    editor.destroy();
  });
  it("leaves ordinary text, code indentation, irregular and oversized input alone", () => {
    for (const text of ["普通文字", "a\tb", "\tcode\n\tnext", "a\tb\nc", 'a\tb\nc\t"unterminated', "a".repeat(500_001)]) {
      expect(clipboardTable(text)).toBeNull();
    }
  });
  it("survives edit, Markdown round trip and undo without losing table structure", () => {
    const editor = makeEditor();
    editor.commands.insertContent(clipboardTable("名称\t状态\n任务\t完成")!);
    const markdown = editor.getMarkdown();
    const restored = makeEditor(markdown);
    expect(restored.getHTML()).toContain("<table");
    expect(restored.getText()).toContain("完成");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getHTML()).not.toContain("<table");
    editor.destroy(); restored.destroy();
  });
});
