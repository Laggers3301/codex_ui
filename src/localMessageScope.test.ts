import { expect, it } from 'vitest';
import { localMessageBelongsToThread } from './localMessageScope';
it('keeps transfer receipts in their originating thread even after async navigation', () => {
  const message = { threadId: 'origin', meta: 'Codex Web · file transfer' };
  expect(localMessageBelongsToThread(message, 'origin')).toBe(true);
  expect(localMessageBelongsToThread(message, 'other')).toBe(false);
  expect(localMessageBelongsToThread(message, null)).toBe(false);
});
it('does not attach transfers made without a thread to another conversation', () => {
  expect(localMessageBelongsToThread({ threadId: null }, 'other')).toBe(false);
  expect(localMessageBelongsToThread({ threadId: null }, null)).toBe(true);
});
it('hides unscoped old transfer receipts without changing unrelated system messages', () => {
  expect(localMessageBelongsToThread({ meta: 'Codex Web · file transfer' }, 'other')).toBe(false);
  expect(localMessageBelongsToThread({ meta: 'Codex Web · 自动发送' }, 'other')).toBe(false);
  expect(localMessageBelongsToThread({ meta: 'Codex Web · system' }, 'other')).toBe(true);
});
