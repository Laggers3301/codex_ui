import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import type { Root, RootContent, Text } from "hast";

const duration = 250;
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const skipped = new Set(["pre", "svg", "math"]);

export interface RevealSnapshot {
  source: string;
  active: Map<number, number>;
  nextStart: number;
}

export const emptyRevealSnapshot = (): RevealSnapshot => ({ source: "", active: new Map(), nextStart: 0 });

/** One transaction per Markdown tree, independent of React component nesting.
 * Source offsets identify text; absolute timestamps survive AST/DOM remounts. */
export function createRevealPass(previous: RevealSnapshot, source: string, now: number, renderedSource = source) {
  // remend can close delimiters and table normalization can insert blank lines
  // before already visible text. Anchor identities to the real source, not to
  // those synthetic characters in the string parsed by ReactMarkdown.
  const sourceOffsets = new Int32Array(renderedSource.length).fill(-1);
  let sourceCursor = 0;
  for (let index = 0; index < renderedSource.length; index++) {
    if (renderedSource[index] === source[sourceCursor]) sourceOffsets[index] = sourceCursor++;
    else if (renderedSource[index] !== "\n") {
      const found = source.indexOf(renderedSource[index], sourceCursor);
      if (found >= 0) { sourceOffsets[index] = found; sourceCursor = found + 1; }
    }
  }
  let prefix = 0;
  while (prefix < previous.source.length && prefix < source.length && previous.source[prefix] === source[prefix]) prefix++;
  let suffix = 0;
  while (suffix < previous.source.length - prefix && suffix < source.length - prefix
    && previous.source[previous.source.length - 1 - suffix] === source[source.length - 1 - suffix]) suffix++;
  const snapshot: RevealSnapshot = { source, active: new Map(), nextStart: previous.nextStart };
  const firstSnapshot = previous.source === "";
  const oldOffset = (offset: number): number | null => {
    if (firstSnapshot || offset < prefix) return offset;
    if (offset >= source.length - suffix) return offset + previous.source.length - source.length;
    return null;
  };
  const candidates: Array<{ node: Text; parent: { children: RootContent[] }; sourceOffset: number }> = [];

  const transform = (tree: Root) => {
    // Plugins can be invoked more than once during a React render. Never count
    // or schedule the same source twice, and never descend into generated spans.
    candidates.length = 0;
    const visit = (parent: { children: RootContent[] }) => {
      for (const node of parent.children) {
        if (node.type === "text" && node.position?.start.offset !== undefined) {
          candidates.push({ node, parent, sourceOffset: node.position.start.offset });
        } else if (node.type === "element" && !skipped.has(node.tagName)
          && !/katex|math-inline|math-display|language-math/.test(String(node.properties.className ?? ""))) visit(node);
      }
    };
    visit(tree);
    const additions: Array<{ offset: number; word: number }> = [];
    const replacements: Array<{ node: Text; parent: { children: RootContent[] }; chars: Array<{ text: string; offset: number }> }> = [];
    let word = 0;
    for (const candidate of candidates) {
      let cursor = candidate.sourceOffset;
      const end = candidate.node.position?.end.offset ?? cursor + candidate.node.value.length;
      const chars: Array<{ text: string; offset: number }> = [];
      for (const part of segmenter.segment(candidate.node.value)) {
        word++;
        for (const char of part.segment) {
          // Locate decoded text in its raw source range. Escapes and entities
          // can occupy more source bytes than visible characters.
          const found = renderedSource.indexOf(char, cursor);
          const renderedOffset = found >= cursor && found < end ? found : cursor;
          const offset = sourceOffsets[renderedOffset] ?? -1;
          cursor = renderedOffset + char.length;
          chars.push({ text: char, offset });
          if (offset < 0 || offset >= source.length || /^\s$/u.test(char)) continue;
          const old = oldOffset(offset);
          const active = old === null ? undefined : previous.active.get(old);
          if (active !== undefined && now < active + duration) snapshot.active.set(offset, active);
          else if (old === null) additions.push({ offset, word });
        }
      }
      replacements.push({ ...candidate, chars });
    }
    const words = [...new Set(additions.map((entry) => entry.word))];
    const start = Math.min(Math.max(previous.nextStart, now), now + 320);
    const step = words.length > 1 ? Math.min(25, Math.max(0, (now + 320 - start) / (words.length - 1))) : 25;
    const schedule = new Map(words.map((id, index) => [id, start + index * step]));
    for (const addition of additions) snapshot.active.set(addition.offset, schedule.get(addition.word)!);
    if (words.length) snapshot.nextStart = start + words.length * step;
    for (const { node, parent, chars } of replacements) {
      const next: RootContent[] = [];
      for (const char of chars) {
        const at = snapshot.active.get(char.offset);
        const last = next[next.length - 1];
        if (at === undefined) {
          if (last?.type === "text") last.value += char.text;
          else next.push({ type: "text", value: char.text });
        } else if (last?.type === "element" && last.properties["data-stream-start"] === at) {
          (last.children[0] as Text).value += char.text;
        } else {
          next.push({ type: "element", tagName: "span", properties: {
            "data-stream-start": at, "data-stream-offset": char.offset
          }, children: [{ type: "text", value: char.text }] });
        }
      }
      const index = parent.children.indexOf(node);
      if (index >= 0) parent.children.splice(index, 1, ...next);
    }
  };
  return { snapshot, plugin: () => transform };
}

export function StreamRevealSpan({ node: _node, ...props }: ComponentPropsWithoutRef<"span"> & {
  node?: unknown;
  "data-stream-start"?: number | string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const start = props["data-stream-start"] === undefined ? null : Number(props["data-stream-start"]);
  useLayoutEffect(() => {
    if (start === null || !Number.isFinite(start) || !element.current || typeof element.current.animate !== "function") return;
    const now = performance.now();
    if (now >= start + duration || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = element.current.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration, delay: Math.max(0, start - now), easing: "ease-out", fill: "both"
    });
    if (now > start) animation.currentTime = now - start;
    return () => animation.cancel();
  }, [start]);
  return <span ref={element} {...props} />;
}
