import type { ThreadHistoryPage } from "./types";

/** Item counts are not page capacity: large tool records hit the byte budget. */
export function isUsableThreadPage(history: ThreadHistoryPage): boolean {
  return history.totalItems > 0
    && (history.returnedItems > 0 || !history.hasOlder)
    && (!history.hasOlder || Boolean(history.nextCursor || history.nextBefore > 0));
}
