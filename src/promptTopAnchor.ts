export interface PromptTopAnchor {
  requestId: string;
  threadId: string | null;
  turnId: string | null;
  viewToken: number;
}

// A viewport-sized reserve must belong to the last visible question only.
// Steering appends a question to the same turn (or briefly to the live tail),
// so checking only the latest turn ID leaves a large hole above that question.
export function resolvePromptTopAnchor(
  anchor: PromptTopAnchor | null,
  viewToken: number,
  threadId: string | null,
  latestTurnId: string | null,
  latestTurnUserCount: number,
  detachedRequestIds: string[]
): { turnId: string | null; liveTail: boolean } {
  if (!anchor || anchor.viewToken !== viewToken || anchor.threadId !== threadId) {
    return { turnId: null, liveTail: false };
  }
  if (detachedRequestIds.some(id => id !== anchor.requestId)) {
    return { turnId: null, liveTail: false };
  }
  const turnId = anchor.turnId === latestTurnId && latestTurnUserCount <= 1 ? anchor.turnId : null;
  return { turnId, liveTail: !turnId && detachedRequestIds.includes(anchor.requestId) };
}
