import {describe,it,expect} from 'vitest';
import {MemoryProcessMonitor,parseProcessRows,directoryOwnerHint} from './memoryProcesses.js';
describe('memory process ranking',()=>{
  it('ranks numeric RSS and limits five rows without command arguments',()=>{
    const rows=parseProcessRows('1 1000 200 node\n2 1000 800 codex\n3 0 20 systemd\nbad\n4 0 0 gone');
    expect(rows.map(p=>p.pid)).toEqual([2,1,3]);expect(rows[0].rssBytes).toBe(819200);
    expect(parseProcessRows(Array.from({length:8},(_,i)=>`${i+1} 1000 ${i+1} node`).join('\n'))).toHaveLength(5);
  });
  it('returns a directory clue, never maps a shared runtime account to a person',()=>{
    expect(directoryOwnerHint('/home/ls/codex_zerotier_remote/users/gyj/scratch')).toBe('gyj');
    expect(directoryOwnerHint('/home/ls/codex_zerotier_remote/runtime/account-pool/260707')).toBeNull();
  });
  it('coalesces and caches on-demand sampling',async()=>{
    let calls=0;const monitor=new MemoryProcessMonitor(async()=>{calls++;return {sampledAt:new Date().toISOString(),processes:[]};});
    const a=monitor.read(),b=monitor.read();expect(a).toBe(b);await a;await monitor.read();expect(calls).toBe(1);
  });
});
