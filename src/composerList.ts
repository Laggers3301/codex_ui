import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { canSplit } from "@tiptap/pm/transform";

function splitSoftLines(editor: Editor): void {
  const { state } = editor;
  const { from, to } = state.selection;
  const breaks: number[] = [];
  state.doc.descendants((node, position) => {
    if (!node.isTextblock || position > to || position + node.nodeSize < from) return;
    node.forEach((child, offset) => {
      if (child.type.name === "hardBreak") breaks.push(position + 1 + offset);
    });
  });
  if (!breaks.length) return;

  const transaction = state.tr;
  // Work backwards so earlier hardBreak positions do not move while splitting.
  for (const position of breaks.reverse()) {
    const resolved = transaction.doc.resolve(position);
    const depth = resolved.depth > 1 && resolved.node(resolved.depth - 1).type.name === "listItem" ? 2 : 1;
    if (!canSplit(transaction.doc, position, depth)) continue;
    transaction.delete(position, position + 1).split(position, depth);
  }
  if (!transaction.docChanged) return;
  const mappedFrom = transaction.mapping.map(from, 1);
  const mappedTo = from === to ? mappedFrom : transaction.mapping.map(to, -1);
  transaction.setSelection(TextSelection.create(transaction.doc, mappedFrom, mappedTo));
  editor.view.dispatch(transaction);
}

export function toggleComposerList(editor: Editor, format: "orderedList" | "bulletList"): void {
  editor.commands.focus();
  splitSoftLines(editor);
  const toggle = () => format === "orderedList"
    ? editor.commands.toggleOrderedList()
    : editor.commands.toggleBulletList();

  if (!editor.isActive(format)) {
    toggle();
    return;
  }

  // In a nested list, Tiptap's first toggle only lifts the selected item to
  // its parent list. Continue until the selected line is genuinely unlisted.
  const maxLevels = editor.state.selection.$from.depth + 1;
  for (let level = 0; level < maxLevels && editor.isActive(format); level += 1) {
    if (!toggle()) break;
  }
}
