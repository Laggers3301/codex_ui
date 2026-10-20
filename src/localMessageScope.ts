export function localMessageBelongsToThread(message: { threadId?: string | null; meta?: string }, currentThreadId: string | null): boolean {
  if (message.threadId !== undefined) return message.threadId === currentThreadId;
  // Old transfer receipts without an origin must not be attributed to a random
  // open conversation. Other genuinely global system messages remain global.
  return message.meta !== 'Codex Web · file transfer' && message.meta !== 'Codex Web · 自动发送';
}
