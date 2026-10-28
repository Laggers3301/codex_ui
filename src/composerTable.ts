import type { JSONContent } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";

export const ComposerTableKit = TableKit.configure({ table: { resizable: false } });

/** Spreadsheet text fallback. Do not reinterpret ordinary tab-indented code. */
export function clipboardTable(text: string): JSONContent | null {
  if (text.length > 500_000 || !text.includes("\t")) return null;
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const source = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"' && (quoted || !cell)) {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === "\t" || char === "\n")) {
      row.push(cell); cell = "";
      if (row.length > 50) return null;
      if (char === "\n") { rows.push(row); row = []; }
      if (rows.length > 200) return null;
    } else cell += char;
  }
  if (quoted) return null;
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const columns = rows[0]?.length ?? 0;
  if (rows.length < 2 || rows.length > 200 || columns < 2 || columns > 50 || rows.length * columns > 2000
    || rows.some(values => values.length !== columns || !values[0])) return null;
  return { type: "table", content: rows.map((values, index) => ({ type: "tableRow", content: values.map(value => ({
    type: index === 0 ? "tableHeader" : "tableCell",
    content: [{ type: "paragraph", content: value ? value.split("\n").flatMap((line, i) => [
      ...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])
    ]) : [] }]
  })) })) };
}
