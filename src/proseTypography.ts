import type { Root, RootContent, Text } from "hast";

const excluded = new Set(["svg", "math", "script", "style"]);
const boundaries = new Set(["p", "div", "li", "td", "th", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "br", "hr", "pre", "code"]);

/** Keep the source/copy text intact. Only Latin-word apostrophes use a Latin
 * font; Chinese quotations retain their original typography. Code blocks use
 * a monospace override for the same span, without rewriting source text. Run
 * after streaming reveal, whose spans may split a word across several nodes. */
export function rehypeLatinApostrophes() {
  return (tree: Root) => {
    const runs: Array<{ node: Text; parent: { children: RootContent[] }; start: number }> = [];
    let text = "";
    const visit = (parent: { children: RootContent[] }) => {
      for (const node of parent.children) {
        if (node.type === "text") {
          runs.push({ node, parent, start: text.length });
          text += node.value;
        } else if (node.type === "element") {
          if (excluded.has(node.tagName) || /katex|math-inline|math-display|latinWordApostrophe/.test(String(node.properties.className ?? ""))) {
            text += "\n";
            continue;
          }
          const boundary = boundaries.has(node.tagName);
          if (boundary) text += "\n";
          visit(node);
          if (boundary) text += "\n";
        }
      }
    };
    visit(tree);
    const offsets = new Set<number>();
    for (const match of text.matchAll(/\p{Script=Latin}\p{M}*[’‘](?=\p{Script=Latin})/gu)) {
      offsets.add(match.index + match[0].length - 1);
    }
    if (!offsets.size) return;
    for (const { node, parent, start } of runs) {
      const replacements: RootContent[] = [];
      let from = 0;
      for (let i = 0; i < node.value.length; i++) {
        if (!offsets.has(start + i)) continue;
        if (i > from) replacements.push({ type: "text", value: node.value.slice(from, i) });
        replacements.push({ type: "element", tagName: "span", properties: { className: ["latinWordApostrophe"] }, children: [{ type: "text", value: node.value[i] }] });
        from = i + 1;
      }
      if (!from) continue;
      if (from < node.value.length) replacements.push({ type: "text", value: node.value.slice(from) });
      const index = parent.children.indexOf(node);
      if (index >= 0) parent.children.splice(index, 1, ...replacements);
    }
  };
}
