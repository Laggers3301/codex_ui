const fencedCodeStartPattern = /^ {0,3}(`{3,}|~{3,})/;

function isFenceClose(line: string, marker: "`" | "~", minimumLength: number): boolean {
  const match = line.match(/^ {0,3}(`+|~+)\s*$/);
  return Boolean(match && match[1][0] === marker && match[1].length >= minimumLength);
}

function isGfmTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && trimmed !== "|";
}

function isGfmTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;

  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = withoutEdges.split("|").map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function isLikelyGfmTableRow(line: string): boolean {
  if (!line.trim() || /^\s{4}/.test(line)) return false;

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "|") continue;
    let backslashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
      backslashCount += 1;
    }
    if (backslashCount % 2 === 0) return true;
  }
  return false;
}

/**
 * Remove Codex interruption markers without destroying Markdown whitespace.
 * Blank lines are semantic boundaries for tables, lists, headings and code,
 * so filtering with trim()/Boolean() here would corrupt otherwise valid GFM.
 */
export function stripInterruptArtifacts(text: string): string {
  const withoutBlocks = text.replace(/<turn_aborted\b[^>]*>[\s\S]*?<\/turn_aborted>/gi, "");
  // Search citations use private-use delimiters that only the first-party
  // transcript renderer can resolve. This client has no URL map for them, so
  // hide the transport token instead of exposing tofu boxes and turn ids.
  const withoutInternalCitations = withoutBlocks
    .replace(/\uE200(?:cite|filecite)\uE202[^\uE201]*\uE201/gi, "")
    .replace(/[ \t]+([,.;:!?，。；：！？])/g, "$1");
  return withoutInternalCitations
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim().toLowerCase();
      return (
        normalized !== "<turn_aborted>"
        && normalized !== "<turn_aborted/>"
        && normalized !== "<turn_aborted />"
        && normalized !== "the user interrupted the previous turn on purpose."
        && normalized !== "any running unified exec processes may still be running in the background."
        && normalized !== "if any tools/commands were aborted, they may have partially executed."
      );
    })
    .join("\n")
    .trim();
}

function normalizeMathInText(text: string): string {
  return text
    .replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g, (whole, equation: string, offset: number, source: string) => {
      const content = equation.trim();
      if (!content) return whole;

      // The whitespace before an opening delimiter belongs to the surrounding
      // Markdown structure (most importantly, a list item). The replacement's
      // first line inherits it from `source`; repeat it on every following line
      // so remark-math cannot mistake prose after the formula for math content.
      const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
      const prefix = source.slice(lineStart, offset);
      const indentation = /^[ \t]*$/.test(prefix) ? prefix : "";
      const indentedContent = indentation
        ? content
          .split(/\r?\n/)
          .map((line) => indentation + (line.startsWith(indentation) ? line.slice(indentation.length) : line))
          .join("\n")
        : content;

      return `$$\n${indentedContent}\n${indentation}$$`;
    })
    .replace(/(?<!\\)\\\(([\s\S]*?)(?<!\\)\\\)/g, (whole, equation: string) => {
      const content = equation.trim();
      return content ? `$${content}$` : whole;
    });
}

function normalizeMathInProse(text: string): string {
  const codeSpanPattern = /(`+)([\s\S]*?)\1/g;
  let result = "";
  let cursor = 0;

  for (const match of text.matchAll(codeSpanPattern)) {
    const start = match.index ?? cursor;
    result += normalizeMathInText(text.slice(cursor, start));
    result += match[0];
    cursor = start + match[0].length;
  }

  return result + normalizeMathInText(text.slice(cursor));
}

/** Convert LaTeX delimiters that remark-math does not parse, without touching code. */
export function normalizeMathMarkdown(text: string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const output: string[] = [];
  let prose = "";
  let fence: { character: "`" | "~"; length: number } | null = null;

  const flushProse = () => {
    if (prose) {
      output.push(normalizeMathInProse(prose));
      prose = "";
    }
  };

  for (const line of lines) {
    if (fence) {
      output.push(line);
      const closingFence = new RegExp(`^\\s*${fence.character}{${fence.length},}`);
      if (closingFence.test(line)) fence = null;
      continue;
    }

    const openingFence = line.match(/^\s*(`{3,}|~{3,})/);
    if (openingFence) {
      flushProse();
      const marker = openingFence[1];
      fence = { character: marker[0] as "`" | "~", length: marker.length };
      output.push(line);
      continue;
    }

    prose += line;
  }

  flushProse();
  return output.join("");
}

/**
 * GFM tables cannot interrupt a paragraph. Models occasionally emit a table
 * header directly after explanatory prose, which makes remark-gfm render the
 * whole block as plain text. Add the missing blank line only when the next two
 * top-level lines are unambiguously a table header and delimiter row.
 */
export function normalizeGfmTableBoundaries(markdown: string): string {
  const lines = markdown.split("\n");
  const normalized: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (fence) {
      normalized.push(line);
      if (isFenceClose(line, fence.marker, fence.length)) fence = null;
      continue;
    }

    const fenceStart = line.match(fencedCodeStartPattern);
    if (fenceStart) {
      const run = fenceStart[1];
      fence = { marker: run[0] as "`" | "~", length: run.length };
      normalized.push(line);
      continue;
    }

    const previousLine = normalized.at(-1);
    const delimiterLine = lines[index + 1];
    const isTopLevel = !/^\s{4}/.test(line);
    if (
      previousLine !== undefined
      && previousLine.trim() !== ""
      && delimiterLine !== undefined
      && isTopLevel
      && isGfmTableHeader(line)
      && isGfmTableDelimiter(delimiterLine)
    ) {
      normalized.push("");
    }

    normalized.push(line);
  }

  const withTableStarts = normalized.join("\n");
  const bounded: string[] = [];
  const boundedLines = withTableStarts.split("\n");
  fence = null;
  let insideTable = false;

  for (let index = 0; index < boundedLines.length; index += 1) {
    const line = boundedLines[index];

    if (fence) {
      bounded.push(line);
      if (isFenceClose(line, fence.marker, fence.length)) fence = null;
      continue;
    }

    const fenceStart = line.match(fencedCodeStartPattern);
    if (fenceStart) {
      if (insideTable) {
        bounded.push("");
        insideTable = false;
      }
      const run = fenceStart[1];
      fence = { marker: run[0] as "`" | "~", length: run.length };
      bounded.push(line);
      continue;
    }

    if (insideTable) {
      if (!line.trim()) {
        insideTable = false;
      } else if (!isLikelyGfmTableRow(line)) {
        bounded.push("");
        insideTable = false;
      }
    }

    bounded.push(line);

    if (
      !insideTable
      && !/^\s{4}/.test(line)
      && isGfmTableHeader(line)
      && boundedLines[index + 1] !== undefined
      && isGfmTableDelimiter(boundedLines[index + 1])
    ) {
      insideTable = true;
    }
  }

  return bounded.join("\n");
}
