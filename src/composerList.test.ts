import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { toggleComposerList } from "./composerList";

function editorWithSelection(markdown: string, selected: string): Editor {
  const editor = new Editor({ extensions: [StarterKit, Markdown], content: markdown, contentType: "markdown" });
  selectText(editor, selected);
  return editor;
}

function selectText(editor: Editor, selected: string): void {
  let from = -1;
  editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text?.includes(selected)) from = position + node.text.indexOf(selected);
  });
  if (from < 0) throw new Error(`Missing selection: ${selected}`);
  editor.commands.setTextSelection({ from, to: from + selected.length });
}

describe("composer list formatting", () => {
  it("unlists only the selected item even when it is nested", () => {
    const editor = editorWithSelection("1. 题目\n   1. 第一项\n   2. 第二项\n   3. 第三项", "第三项");
    toggleComposerList(editor, "orderedList");
    expect(editor.getMarkdown()).toContain("1. 第一项\n   2. 第二项");
    expect(editor.getMarkdown()).toMatch(/\n\n第三项$/);
    editor.destroy();
  });

  it("numbers only the selected paragraph and can toggle it off", () => {
    const editor = editorWithSelection("第一段\n\n第二段\n\n第三段", "第二段");
    toggleComposerList(editor, "orderedList");
    expect(editor.getMarkdown()).toBe("第一段\n\n1. 第二段\n\n第三段");
    toggleComposerList(editor, "orderedList");
    expect(editor.getMarkdown()).toBe("第一段\n\n第二段\n\n第三段");
    editor.destroy();
  });

  it("unlists only the selected bullet without changing its siblings", () => {
    const editor = editorWithSelection("- 第一项\n  - 第二项\n  - 第三项", "第三项");
    toggleComposerList(editor, "bulletList");
    expect(editor.getMarkdown()).toContain("- 第一项\n  - 第二项");
    expect(editor.getMarkdown()).toMatch(/\n\n第三项$/);
    editor.destroy();
  });

  it("turns only one Shift+Enter line into a numbered item", () => {
    const editor = editorWithSelection("第一行  \n第二行  \n第三行", "第一行");
    toggleComposerList(editor, "orderedList");
    expect(editor.getMarkdown()).toBe("1. 第一行\n\n第二行\n\n第三行");
    editor.destroy();
  });

  it("can number another soft line and unlist only the selected line", () => {
    const editor = editorWithSelection("第一行  \n第二行  \n第三行", "第一行");
    toggleComposerList(editor, "orderedList");
    selectText(editor, "第二行");
    toggleComposerList(editor, "orderedList");
    expect(editor.getMarkdown()).toBe("1. 第一行\n2. 第二行\n\n第三行");
    toggleComposerList(editor, "orderedList");
    expect(editor.getMarkdown()).toBe("1. 第一行\n\n第二行\n\n第三行");
    editor.destroy();
  });

  it("creates the next numbered item for Shift+Enter inside a list", () => {
    const editor = editorWithSelection("1. 第一行", "第一行");
    editor.commands.setTextSelection(editor.state.doc.content.size - 3);
    expect(editor.commands.splitListItem("listItem")).toBe(true);
    expect(editor.getJSON().content?.[0]?.content).toHaveLength(2);
    editor.destroy();
  });
});
