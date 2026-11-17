import { nodeInputRule } from "@tiptap/core";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import { decodeLegacyMathSource } from "./markdown";

// Plain-text pastes in older drafts escaped Markdown punctuation once. Undo
// exactly that one layer only inside the distinctive \\\[ ... \\\] wrappers;
// never globally replace backslashes (matrix row breaks must survive).
function mathToken(src: string, block: boolean) {
  const escaped = src.match(block ? /^\\{3}\[([\s\S]+?)\\{3}\]/ : /^\\{3}\(([^\n]+?)\\{3}\)/);
  const match = escaped ?? src.match(block ? /^\\\[([\s\S]+?)\\\]/ : /^\\\(([^\n]+?)\\\)/)
    ?? src.match(block ? /^\$\$([^$]+)\$\$/ : /^\$([^$\n]+)\$(?!\$)/);
  if (!match || !match[1].trim()) return undefined;
  return { type: block ? "blockMath" : "inlineMath", raw: match[0], latex: (escaped ? decodeLegacyMathSource(match[1]) : match[1]).trim() };
}

export const ComposerInlineMath = InlineMath.extend({
  markdownTokenizer: {
    name: "inlineMath", level: "inline",
    start: (src: string) => src.search(/\$|\\+\(/),
    tokenize: (src: string) => mathToken(src, false),
  },
  addInputRules() {
    return [/((?<!\$)\$([^$\n]+)\$(?!\$))$/, /(\\\(([^\n]+?)\\\))$/].map(find => nodeInputRule({
      find, type: this.type, getAttributes: match => ({ latex: match[2] }),
    }));
  },
});

export const ComposerBlockMath = BlockMath.extend({
  markdownTokenizer: {
    name: "blockMath", level: "block",
    start: (src: string) => src.search(/\$\$|\\+\[/),
    tokenize: (src: string) => mathToken(src, true),
  },
  addInputRules() {
    return [/^(\$\$([^$\n]+)\$\$)$/, /^(\\\[([^\n]+?)\\\])$/].map(find => nodeInputRule({
      find, type: this.type, getAttributes: match => ({ latex: match[2] }),
    }));
  },
});

export function hasComposerMath(text: string): boolean {
  return /\$\$[\s\S]+?\$\$|(?<![\\$])\$[^$\n]+\$(?!\$)|\\+\[[\s\S]+?\\+\]|\\+\([^\n]+?\\+\)/.test(text);
}
