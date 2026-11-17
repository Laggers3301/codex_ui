export interface QueuedSubmission {
  id: string;
  input: Array<{ type: string; text?: string; name?: string }>;
  clientUserMessageId: string;
}

/** Queue/add already returns the accepted entry. Unlock that row on its ack,
 * without waiting for a second queue/list round trip. A late ack must not
 * resurrect a row already consumed by the server or duplicate a listed row. */
export function confirmQueuedSubmission(current: QueuedSubmission[], requestId: string, value: unknown): QueuedSubmission[] {
  if (!value || typeof value !== "object") return current;
  const entry = value as Partial<QueuedSubmission>;
  if (typeof entry.id !== "string" || !entry.id || entry.id.startsWith("pending:")
    || !Array.isArray(entry.input) || !entry.input.every(part => part && typeof part.type === "string"
      && (part.text === undefined || typeof part.text === "string") && (part.name === undefined || typeof part.name === "string"))
    || (entry.clientUserMessageId !== undefined && entry.clientUserMessageId !== requestId)) return current;
  const pendingId = `pending:${requestId}`;
  if (!current.some(item => item.id === pendingId)) return current;
  const confirmed: QueuedSubmission = { id: entry.id, input: entry.input, clientUserMessageId: requestId };
  const listed = current.some(item => item.id === confirmed.id);
  return current.flatMap(item => item.id === pendingId ? listed ? [] : [confirmed] : [item]);
}

/** Restore a failed steer near its surviving neighbours without duplicating a refreshed queue entry. */
export function restoreQueuedSubmission(current: QueuedSubmission[], entry: QueuedSubmission, originalOrder: string[]): QueuedSubmission[] {
  if (current.some(item => item.id === entry.id)) return current;
  const index = originalOrder.indexOf(entry.id);
  const nextId = index < 0 ? undefined : originalOrder.slice(index + 1).find(id => current.some(item => item.id === id));
  const previousId = index < 0 ? undefined : originalOrder.slice(0, index).reverse().find(id => current.some(item => item.id === id));
  const position = nextId ? current.findIndex(item => item.id === nextId)
    : previousId ? current.findIndex(item => item.id === previousId) + 1 : Math.min(Math.max(index, 0), current.length);
  const restored = [...current];
  restored.splice(position, 0, entry);
  return restored;
}
