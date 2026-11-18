import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectStore } from './db.js';
import type { CodexBridge } from './codexBridge.js';
import { CodexBackgroundTasks } from './codexBackgroundTasks.js';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-background-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new ProjectStore(path.join(directory, 'app.sqlite'));
  cleanups.push(() => store.close());
  const project = store.createProject({ name: 'test', rootPath: directory });
  store.registerThreadOwner({ threadId: 'parent', userId: 'admin', projectId: project.id, rootPath: directory });
  const bridge = new EventEmitter() as EventEmitter & { request: ReturnType<typeof vi.fn> };
  bridge.request = vi.fn(async () => ({ data: [], nextCursor: null }));
  const tasks = new CodexBackgroundTasks(bridge as unknown as CodexBridge, store);
  cleanups.push(() => tasks.close());
  const event = (method: string, item: Record<string, unknown>) => bridge.emit('notification', { method, params: { threadId: 'parent', item } });
  const terminal = { itemId: 'exec-one', processId: 'native-private', command: 'sleep 10; printf done', cwd: '/private/workspace', osPid: 412, cpuPercent: 0, rssKb: 100 };
  return { store, bridge, tasks, event, terminal };
}
it('reads native running jobs, preserves output and completion across reader recreation, and excludes control metadata', async () => {
  const f = fixture();
  f.bridge.request.mockResolvedValue({ data: [f.terminal], nextCursor: null });
  f.event('item/started', { id: 'exec-one', type: 'commandExecution', processId: 'native-private', command: f.terminal.command, status: 'inProgress' });
  const running = await f.tasks.read('admin', 'parent');
  expect(running).toMatchObject({ supported: true, data: [{ id: 'exec-one', kind: 'shell', status: 'running', background: true }] });
  expect(JSON.stringify(running)).not.toMatch(/processId|osPid|rssKb|cwd|native-private|private\/workspace/);
  f.bridge.emit('notification', { method: 'item/commandExecution/outputDelta', params: { threadId: 'parent', itemId: 'exec-one', delta: 'live output\n' } });
  expect((await f.tasks.read('admin', 'parent')).data[0].summary).toContain('live output');
  f.event('item/completed', { id: 'exec-one', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'live output\ndone\n' });
  f.bridge.request.mockResolvedValue({ data: [], nextCursor: null });
  expect((await f.tasks.read('admin', 'parent')).data[0]).toMatchObject({ status: 'completed', summary: 'live output\ndone\n' });
  f.tasks.close();
  const restarted = new CodexBackgroundTasks(f.bridge as unknown as CodexBridge, f.store); cleanups.push(() => restarted.close());
  f.bridge.request.mockRejectedValue(new Error('thread not loaded: parent'));
  expect((await restarted.read('admin', 'parent')).data[0]).toMatchObject({ status: 'completed', summary: 'live output\ndone\n' });
  expect(f.bridge.request.mock.calls.every(call => call[0] === 'thread/backgroundTerminals/list')).toBe(true);
});
it('never labels an ordinary shell as a background job or disappearance as successful completion', async () => {
  const f = fixture();
  f.event('item/started', { id: 'foreground', type: 'commandExecution', command: 'pwd', processId: 'fg' });
  expect((await f.tasks.read('admin', 'parent')).data).toEqual([]);
  f.bridge.request.mockResolvedValue({ data: [f.terminal], nextCursor: null });
  await f.tasks.read('admin', 'parent');
  f.bridge.request.mockResolvedValue({ data: [], nextCursor: null });
  expect((await f.tasks.read('admin', 'parent')).data[0].status).toBe('unknown');
  f.event('item/completed', { id: 'exec-one', type: 'commandExecution', status: 'completed', exitCode: 4, aggregatedOutput: 'failure evidence' });
  expect((await f.tasks.read('admin', 'parent')).data[0]).toMatchObject({ status: 'failed', summary: 'failure evidence' });
});
it('enforces the owner before RPC and coalesces simultaneous directory reads', async () => {
  const f = fixture();
  await expect(f.tasks.read('someone-else', 'parent')).rejects.toThrow('其他用户');
  expect(f.bridge.request).not.toHaveBeenCalled();
  let resolve!: (value: unknown) => void;
  f.bridge.request.mockImplementation(() => new Promise(ready => { resolve = ready; }));
  const first = f.tasks.read('admin', 'parent'), second = f.tasks.read('admin', 'parent');
  expect(f.bridge.request).toHaveBeenCalledTimes(1);
  resolve({ data: [f.terminal], nextCursor: null });
  expect(await first).toEqual(await second);
});
it('handles an older runtime without pretending to support jobs and preserves real runtime errors', async () => {
  const f = fixture();
  f.bridge.request.mockRejectedValue(new Error('unknown variant thread/backgroundTerminals/list'));
  expect(await f.tasks.read('admin', 'parent')).toEqual({ supported: false, data: [] });
  f.bridge.request.mockRejectedValue(new Error('Account authentication failed'));
  await expect(f.tasks.read('admin', 'parent')).rejects.toThrow('Account authentication failed');
});
