import type { CodexBridge } from "./codexBridge.js";

export const THREAD_LIST_PAGE_SIZE = 100;

export interface CodexThreadListParams {
  cwd?: string;
  cursor?: string | null;
  limit?: number | null;
  sortKey?: string;
  sortDirection?: string;
  archived?: boolean;
  searchTerm?: string | null;
  useStateDbOnly?: boolean;
}

export interface CodexThreadListResponse<T = unknown> {
  data: T[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

type ThreadListBridge = Pick<CodexBridge, "request">;

function toThreadListResponse(value: unknown): CodexThreadListResponse {
  if (!value || typeof value !== "object") {
    throw new Error("Codex returned an invalid thread list response.");
  }

  const response = value as { data?: unknown; nextCursor?: unknown; backwardsCursor?: unknown };
  if (!Array.isArray(response.data)) {
    throw new Error("Codex thread list response is missing data.");
  }

  return {
    data: response.data,
    nextCursor: typeof response.nextCursor === "string" ? response.nextCursor : null,
    backwardsCursor: typeof response.backwardsCursor === "string" ? response.backwardsCursor : null
  };
}

export async function listAllCodexThreads(
  bridge: ThreadListBridge,
  params: Omit<CodexThreadListParams, "cursor">
): Promise<CodexThreadListResponse> {
  const data: unknown[] = [];
  const seenCursors = new Set<string>();
  let backwardsCursor: string | null = null;
  let cursor: string | null = null;

  for (;;) {
    const page = toThreadListResponse(
      await bridge.request("thread/list", {
        ...params,
        cursor
      })
    );

    data.push(...page.data);
    backwardsCursor ??= page.backwardsCursor;

    if (!page.nextCursor) {
      return {
        data,
        nextCursor: null,
        backwardsCursor
      };
    }

    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Codex returned a repeated thread list cursor.");
    }

    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
