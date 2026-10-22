/** Acknowledged messages can remain visible until history catches up, but are
 * not requests waiting to start. Terminal turns must never be resurrected by
 * a late RPC acknowledgement. */
export function pendingTurnStart<T extends { turnId?: string | null }>(messages: T[]): T | null {
  return [...messages].reverse().find(message => !message.turnId) ?? null;
}

export function finishActiveTurn(active: Record<string, string>, threadId: string, turnId: string | null): Record<string, string> {
  if (!active[threadId] || (turnId && active[threadId] !== turnId)) return active;
  const next = { ...active };
  delete next[threadId];
  return next;
}

export function rememberTerminalTurn(terminals: Set<string>, turnId: string): void {
  terminals.add(turnId);
  while (terminals.size > 512) terminals.delete(terminals.values().next().value!);
}
