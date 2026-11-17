import {afterEach,expect,it,vi} from 'vitest';
vi.hoisted(()=>{Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}});});
import {branchThread} from './api';
import {branchProgressLabel} from './BranchTargetDialog';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
it('starts once and polls bounded status requests instead of holding or replaying the creation POST',async()=>{
 vi.useFakeTimers();const progress=vi.fn();
 const fetch=vi.fn().mockResolvedValueOnce(response({data:{branchPending:true,operationId:'op'}},202))
  .mockResolvedValueOnce(response({data:{phase:'importing',stage:'import',totalMessages:90000,importedMessages:128,updatedAt:1}}))
  .mockResolvedValueOnce(response({data:{phase:'completed',totalMessages:90000,importedMessages:90000,updatedAt:2,result:{data:{thread:{id:'existing-child'},branchMode:'cross-runtime'}}}}));
 vi.stubGlobal('fetch',fetch);
 const result=branchThread('project','source',{turnId:'turn',model:'reclaude-opus@1',operationId:'op',onProgress:progress});
 await vi.runAllTimersAsync();expect((await result).data.thread.id).toBe('existing-child');
 expect(fetch.mock.calls.filter(([,options])=>options.method==='POST')).toHaveLength(1);
 expect(JSON.parse(fetch.mock.calls[0][1].body).background).toBe(true);
 expect(fetch.mock.calls[1][0]).toContain('/branch-status/op');
 expect(progress.mock.calls[0][0].importedMessages).toBe(128);
});
it('retries only status reads after a temporary disconnect',async()=>{
 vi.useFakeTimers();const fetch=vi.fn().mockResolvedValueOnce(response({data:{branchPending:true,operationId:'op'}},202))
  .mockRejectedValueOnce(new Error('network disconnected'))
  .mockResolvedValueOnce(response({data:{phase:'completed',totalMessages:1,importedMessages:1,updatedAt:2,result:{data:{thread:{id:'child'}}}}}));
 vi.stubGlobal('fetch',fetch);
 const result=branchThread('project','source',{turnId:'turn',model:'reclaude-opus@1',operationId:'op'});
 await vi.runAllTimersAsync();expect((await result).data.thread.id).toBe('child');
 expect(fetch.mock.calls.filter(([,options])=>options.method==='POST')).toHaveLength(1);
});
it('shows stage and actual imported counts, not a fake timer percentage',()=>{
 const base={phase:'preparing',totalMessages:91709,importedMessages:0,updatedAt:1};
 expect(branchProgressLabel(base)).toContain('91,709');
 expect(branchProgressLabel({...base,phase:'importing',stage:'import',importedMessages:1024})).toBe('导入历史 1,024 / 91,709 条');
 expect(branchProgressLabel({...base,phase:'completed'})).toContain('正在打开');
});
