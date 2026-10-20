import { describe, expect, it } from 'vitest';
import { finishActiveTurn, pendingTurnStart, rememberTerminalTurn } from './turnLifecycle';

describe('terminal turn lifecycle', () => {
  it('does not show stop for an acknowledged message retained for attachments', () => {
    expect(pendingTurnStart([{ turnId: 'failed', text: '继续' }])).toBeNull();
    expect(pendingTurnStart([{ turnId: 'failed' }, { turnId: null }])).toEqual({ turnId: null });
  });
  it('clears a failed turn without stopping a newer turn or another thread', () => {
    expect(finishActiveTurn({ a: 'old', b: 'running' }, 'a', 'old')).toEqual({ b: 'running' });
    const active = { a: 'new', b: 'running' };
    expect(finishActiveTurn(active, 'a', 'old')).toBe(active);
  });
  it('retains terminal IDs for late acknowledgements with bounded memory', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 600; i++) rememberTerminalTurn(ids, String(i));
    expect(ids.size).toBe(512);
    expect(ids.has('599')).toBe(true);
    expect(ids.has('0')).toBe(false);
  });
});
