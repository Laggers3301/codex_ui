import { describe, expect, it } from 'vitest';
import { HistoryReadScheduler } from './historyReadScheduler.js';

function gate() { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { wait, open }; }

describe('bounded history reads', () => {
  it('does not block a ready page behind another thread waiting for its index', async () => {
    const scheduler = new HistoryReadScheduler(), slow = gate(), order: string[] = [];
    const a = scheduler.run(async () => { await slow.wait; }, async () => { order.push('A'); return 'A'; });
    const b = scheduler.run(async () => {}, async () => { order.push('B'); return 'B'; });
    expect(await b).toBe('B'); expect(order).toEqual(['B']);
    slow.open(); expect(await a).toBe('A'); expect(order).toEqual(['B', 'A']);
  });
  it('never overlaps parsers and releases the slot after a failure', async () => {
    const scheduler = new HistoryReadScheduler(), first = gate(), started = gate();
    let active = 0, maxActive = 0;
    const a = scheduler.run(async () => {}, async () => { active++; maxActive = Math.max(maxActive, active); started.open(); await first.wait; active--; throw Error('fixture'); });
    const handled = a.catch(() => 'failed');
    await started.wait;
    const b = scheduler.run(async () => {}, async () => { active++; maxActive = Math.max(maxActive, active); active--; return 'ok'; });
    await Promise.resolve(); expect(active).toBe(1);
    first.open(); expect(await handled).toBe('failed'); expect(await b).toBe('ok'); expect(maxActive).toBe(1);
  });
  it('does not poison the queue when preparation fails', async () => {
    const scheduler = new HistoryReadScheduler();
    await expect(scheduler.run(async () => { throw Error('prepare'); }, async () => 1)).rejects.toThrow('prepare');
    expect(await scheduler.run(async () => {}, async () => 2)).toBe(2);
  });
});
