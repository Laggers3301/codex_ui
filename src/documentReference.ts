import type { WritingSelection } from "./writing/types";

export type ComposerDocumentReference = WritingSelection & { projectId: string };

/** Hide only workbench transport blocks, not the user's actual question. */
export function withoutDocumentContext(text: string): string {
  return text.replace(/(?:\r?\n)*<codex_document_context>\s*Document selection context supplied by the writing workbench\.[\s\S]*?<\/codex_document_context>(?:\r?\n)*/g, "\n").trim();
}
