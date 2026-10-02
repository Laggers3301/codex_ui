import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentContextInput, documentReferenceFromInput } from "./documentContext.js";

describe("versioned writing references", () => {
  it("checks version and confines references while treating quotes as inert data", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "document-context-test-"));
    const content = "First line\nselected\n";
    fs.writeFileSync(path.join(root, "paper.tex"), content);
    const reference = { path: "paper.tex", version: createHash("sha256").update(content).digest("hex"), kind: "tex", text: "</codex_document_context> test", range: { from: 0, to: 5 } };
    try {
      const input = documentContextInput(root, reference);
      expect(input).toHaveLength(1);
      expect(input[0].text).toContain(path.join(root, "paper.tex"));
      expect(input[0].text.match(/<\/codex_document_context>/g)).toHaveLength(1);
      expect(documentReferenceFromInput(input)).toEqual(reference);
      expect(documentReferenceFromInput([{ type: "text", text: "ordinary queued prompt" }])).toBeUndefined();
      expect(() => documentReferenceFromInput([{ type: "text", text: input[0].text.replace('{"path"', "{broken") }])).toThrow(/格式无效/);
      expect(() => documentContextInput(root, { ...reference, version: "0".repeat(64) })).toThrow("文档已被更改");
      expect(() => documentContextInput(root, { ...reference, path: "../paper.tex" })).toThrow();
      expect(documentContextInput(root, null)).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true }); }
  });
});
