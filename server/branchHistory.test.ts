import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

it('paginates local and archived inherited messages, respecting the fork boundary and ownership', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'branch-history-'));
  const parent='11111111-1111-4111-8111-111111111111', child='22222222-2222-4222-8222-222222222222';
  vi.stubEnv('CODEX_THREAD_INDEX_DB',path.join(root,'index.sqlite'));
  vi.stubEnv('CODEX_WEB_CODEX_SESSION_ROOTS',root);vi.resetModules();
  const line=(x:unknown)=>JSON.stringify(x)+'\n';
  const turn=(id:string,text:string)=>line({type:'turn_context',payload:{turn_id:id}})+line({type:'response_item',payload:{type:'message',id,role:'assistant',content:[{type:'output_text',text}]}});
  const inherited=line({type:'session_meta',payload:{id:parent,history_mode:'paginated'}})+turn('one','PARENT_ONE')+turn('two','PARENT_TWO');
  const parentFile=path.join(root,`rollout-${parent}.jsonl`),childFile=path.join(root,`rollout-${child}.jsonl`);
  await fs.writeFile(parentFile,inherited+turn('future','AFTER_FORK'));
  await fs.writeFile(childFile,line({type:'session_meta',payload:{id:child,history_mode:'paginated',history_base:{thread_id:parent,end_byte_offset:Buffer.byteLength(inherited)}}})+turn('child','CHILD'));
  try {
    const {readBranchHistoryPage,readBranchHistoryItem}=await import('./branchHistory.js');
    let page=await readBranchHistoryPage(childFile,child,{limit:1},()=>true);
    expect(JSON.stringify(page.thread.turns)).toContain('CHILD');expect(page.history.hasOlder).toBe(true);
    page=await readBranchHistoryPage(childFile,child,{limit:1,cursor:page.history.nextCursor},()=>true);
    expect(JSON.stringify(page.thread.turns)).toContain('PARENT_TWO');expect(JSON.stringify(page.thread.turns)).not.toContain('AFTER_FORK');
    page=await readBranchHistoryPage(childFile,child,{limit:1,cursor:page.history.nextCursor},()=>true);
    expect(JSON.stringify(page.thread.turns)).toContain('PARENT_ONE');expect(page.history.hasOlder).toBe(false);
    const before=await readBranchHistoryPage(childFile,child,{limit:1,before:1},()=>true);
    expect(JSON.stringify(before.thread.turns)).toContain('PARENT_TWO');
    expect(JSON.stringify(await readBranchHistoryItem(childFile,child,'two',()=>true))).toContain('PARENT_TWO');
    expect(await readBranchHistoryItem(childFile,child,'future',()=>true)).toBeNull();
    await fs.writeFile(parentFile,inherited.slice(0,Math.max(0,inherited.length-1)));
    await expect(readBranchHistoryPage(childFile,child,{limit:1},()=>true)).rejects.toThrow('来源历史不完整');
    await expect(readBranchHistoryPage(childFile,child,{limit:1},()=>false)).rejects.toThrow('无权');
  } finally { vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true}); }
},30000);
