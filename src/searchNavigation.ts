import type { ThreadSummary } from "./types";

export function exactSearchTurn(thread: ThreadSummary, itemId: string): string | null {
  for (const turn of thread.turns ?? []) {
    if ((turn.items ?? []).some(item => item.id === itemId) || `${turn.id}-user-input` === itemId) return turn.id;
  }
  return null;
}

/** Wait for virtualization to mount the exact message; do not replace its ID
 * with a keyword match or spend retries fetching unrelated history pages. */
export async function waitForSearchTarget<T>(options: {
  getTarget: () => T | undefined;
  scrollToTurn: () => void;
  isCurrent: () => boolean;
  nextFrame: () => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<T | null> {
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.timeoutMs ?? 1200);
  for (let frame = 0; frame < 80 && now() <= deadline; frame++) {
    await options.nextFrame();
    if (!options.isCurrent()) return null;
    const target = options.getTarget();
    if (target) return target;
    if (frame % 4 === 0) options.scrollToTurn();
  }
  return null;
}
