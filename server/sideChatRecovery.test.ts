import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from './db.js';
import type { CodexBridge } from './codexBridge.js';
import { closeSideChat, reconcileSideChat } from './sideChats.js';

function fixture(attached = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'side-recovery-'));
  const db = path.join(root, 'test.sqlite');
  let store = new ProjectStore(db);
  const project = store.createProject({ name: 'isolated', rootPath: root });
  for (const threadId of ['main', 'child']) store.registerThreadOwner({ threadId, userId: 'admin', projectId: project.id, rootPath: root });
  const side = store.sideChats.create('main', 'admin', project.id, 'quote', 'sol');
  store.sideChats.begin(side.id, 'admin', project.id, 'r1', 'keep my question', null);
  if (attached) { store.sideChats.attach(side.id, 'admin', 'r1', 'child'); store.sideChats.accepted(side.id, 'admin', 'r1', 't1'); }
  return { get store() { return store; }, side, project,
    restart() { store.close(); store = new ProjectStore(db); },
    current() { return store.sideChats.byId(side.id, 'admin')!; },
    dispose() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function bridge(data: unknown, calls: Array<{method: string; params: any}> = []) {
  return { request: async (method: string, params: any) => { calls.push({method, params}); return {data}; } } as unknown as CodexBridge;
}

describe('side chat recovery after backend restart', () => {
  it('makes an orphaned start retryable without querying a model or losing its question', async () => {
    const f = fixture(); const calls: any[] = [];
    try {
      f.restart();
      expect(await reconcileSideChat(bridge([], calls), f.store, f.current())).toMatchObject({ status: 'error', draft: 'keep my question', threadId: null });
      expect(calls).toEqual([]);
      expect(() => f.store.sideChats.begin(f.side.id, 'admin', f.project.id, 'r2', 'retry', null)).not.toThrow();
    } finally { f.dispose(); }
  });
  it('can close an orphaned pre-restart start instead of waiting for a dead callback', async () => {
    const f = fixture();
    try { f.restart(); await closeSideChat(bridge([]), f.store, f.current()); expect(f.current()).toBeNull(); }
    finally { f.dispose(); }
  });
  it('preserves live native work and uses only one metadata-only read', async () => {
    const f = fixture(true); const calls: any[] = [];
    try {
      f.restart();
      expect(await reconcileSideChat(bridge([{id:'t1',status:'inProgress'}], calls), f.store, f.current())).toMatchObject({status:'running',turnId:'t1'});
      expect(calls).toEqual([{method:'thread/turns/list',params:{threadId:'child',limit:1,itemsView:'notLoaded',sortDirection:'desc'}}]);
      await reconcileSideChat(bridge([], calls), f.store, f.current()); expect(calls).toHaveLength(1);
      expect(f.store.userCanAccessThread('main','admin',f.project.id)).toBe(true);
    } finally { f.dispose(); }
  });
  it('reconciles completed and failed native turns without fabricating success', async () => {
    for (const status of ['completed','failed','interrupted']) {
      const f = fixture(true);
      try { f.restart(); expect(await reconcileSideChat(bridge([{id:'t1',status}]),f.store,f.current())).toMatchObject({status:status==='completed'?'complete':'error'}); }
      finally { f.dispose(); }
    }
  });
  it('keeps uncertain state retryable when metadata is unavailable or unknown', async () => {
    for (const b of [bridge(undefined),bridge([{id:'t1',status:'unknown'}]), {request:async()=>{throw new Error('timeout');}} as unknown as CodexBridge]) {
      const f=fixture(true);
      try { f.restart(); await expect(reconcileSideChat(b,f.store,f.current())).rejects.toMatchObject({statusCode:503}); expect(f.current().status).toBe('running'); expect(f.store.sideChats.needsReconciliation(f.side.id)).toBe(true); }
      finally { f.dispose(); }
    }
  });
  it('does not cancel an in-process start when another tab reads it', async () => {
    const f=fixture(); const calls:any[]=[];
    try { expect(await reconcileSideChat(bridge([],calls),f.store,f.current())).toMatchObject({status:'starting'}); expect(calls).toEqual([]); }
    finally { f.dispose(); }
  });
  it('does not overwrite a notification that wins a metadata-read race', async () => {
    const f=fixture(true); let resolve!: (value:unknown)=>void;
    try {
      f.restart(); const pending=reconcileSideChat({request:()=>new Promise(done=>{resolve=done;})} as unknown as CodexBridge,f.store,f.current());
      f.store.sideChats.turn('child','t1',true); resolve({data:[{id:'t1',status:'inProgress'}]});
      expect(await pending).toMatchObject({status:'complete'});
    } finally { f.dispose(); }
  });
});
