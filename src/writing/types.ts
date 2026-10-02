export type WritingKind = "tex" | "docx" | "pdf";

export type WritingSelection = {
  path: string;
  version: string;
  kind: WritingKind;
  text: string;
  range?: {
    from: number;
    to: number;
    lineStart?: number;
    lineEnd?: number;
    blockId?: string;
    endBlockId?: string;
    segments?: unknown[];
  };
  page?: number;
  x?: number;
  y?: number;
};

export type WritingProject = { id: string; name: string; rootPath: string };
export type TreeEntry = { path: string; name: string; kind: "directory" | "tex" | "docx" | "asset"; size: number };
export type TreeResponse = { directory: string; entries: TreeEntry[]; nextOffset: number | null; capabilities?: Record<string, boolean> };
export type OpenedDocument = { path: string; name: string; kind: "tex" | "docx" | "pdf" | "asset"; version: string; size: number; content?: string; rawUrl?: string };
export type DocumentJob = { id: string; state: "queued" | "running" | "succeeded" | "failed" | "cancelled"; version: string; path: string; pdfUrl?: string; outputPath?: string; log?: string; error?: string };

export type WorkbenchProps = {
  project: WritingProject;
  initialPath?: string | null;
  onReference(selection: WritingSelection): void;
  onClose(): void;
  onToggleChat?: () => void;
  chatVisible?: boolean;
  closing?: boolean;
  revision?: string | number;
};
