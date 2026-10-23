import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({source:null as string|null, size:0, rejectBudget:false, checked:[] as number[]}));
vi.mock('./threadFallback.js',()=>({findThreadJsonlPathById:async()=>state.source,threadJsonlSessionsRoot:(file:string)=>path.dirname(file)}));
vi.mock('./rolloutStorage.js',async original=>({...await original<typeof import('./rolloutStorage.js')>(),rolloutLogicalStat:async()=>({size:state.size})}));
vi.mock('./accountPoolBridge.js',()=>({isAccountPoolBridge:(value:any)=>value.pool===true}));
vi.mock('./largeThreadFork.js',async original=>({...await original<typeof import('./largeThreadFork.js')>(),assertLargeBranchMemory:(bytes:number)=>{state.checked.push(bytes);if(state.rejectBudget)throw new Error('insufficient memory');}}));
import { ProjectStore } from './db.js';
import type { CodexBridge } from './codexBridge.js';
import { branchGate,largeThreadForkBytes } from './largeThreadFork.js';
import { forkSideChatContext } from './sideChatFork.js';
import { toolArchivePath,toolArchiveRoot } from './toolOutputArchive.js';
import { serverConfig } from './config.js';
import { gunzipSync } from 'node:zlib';

async function fixture() {
  state.source=null;state.size=0;state.rejectBudget=false;state.checked=[];
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'side-fork-safe-'));
  const store=new ProjectStore(path.join(root,'test.sqlite'));
  const project=store.createProject({name:'isolated',rootPath:root});
  store.registerThreadOwner({threadId:'main',userId:'admin',projectId:project.id,rootPath:root});
  const calls:Array<{method:string;params:any}>=[];
  const bridge={pool:true,resolveThreadAccount:async()=>({id:'isolated'}),canThreadUseModel:()=>true,
    getBranchRoutingDecision:()=>({targetAccount:{id:'isolated',codexHome:root}}),getAccountMemoryHeadroom:()=>1024**3,
    assignThreadsToAccount:vi.fn(),request:async(method:string,params:any)=>{calls.push({method,params});return {thread:{id:params.threadId==='main'?'child':params.threadId,path:state.source}};}};
  const params={model:'gpt-6.1-sol',cwd:root,sandbox:'read-only'};
  return {root,store,project,calls,bridge,params,
    run:()=>forkSideChatContext(bridge as unknown as CodexBridge,store,'admin',project.id,'main',params,'high'),
    source:async(legacy=true)=>{await fs.mkdir(path.join(root,'source'),{recursive:true});state.source=path.join(root,'source','rollout.jsonl');
      const rows=[{type:'session_meta',payload:{id:'main',history_mode:legacy?'legacy':'paginated'}}];
      for(const id of ['one','two','three'])rows.push(...[
        {type:'event_msg',payload:{type:'task_started',turn_id:id}},
        {type:'response_item',payload:{type:'custom_tool_call_output',call_id:id,output:id+':'+ 'x'.repeat(200000)}},
        {type:'event_msg',payload:{type:'task_complete',turn_id:id}}] as any);
      await fs.writeFile(state.source,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');return fs.readFile(state.source,'utf8');},
    dispose:async()=>{store.close();await fs.rm(root,{recursive:true,force:true});}};
}
describe('guarded same-account side forks',()=>{
  it('shares the ordinary branch lock and releases it after failure',async()=>{
    const f=await fixture(),release=branchGate.enter();
    try{await expect(f.run()).rejects.toThrow(/已有分支/);expect(f.calls).toHaveLength(0);}
    finally{release();await f.dispose();}
  });
  it('budgets a small native fork and keeps goal continuation deferred',async()=>{
    const f=await fixture();
    try{await f.source();state.size=1024;await f.run();expect(state.checked).toEqual([1024,1024]);expect(f.calls).toEqual([{method:'thread/fork',params:expect.objectContaining({threadId:'main',excludeTurns:true,deferGoalContinuation:true})}]);}
    finally{await f.dispose();}
  });
  it('rejects missing metadata and incompatible models before a native fork',async()=>{
    const f=await fixture();
    try{await expect(f.run()).rejects.toThrow(/历史大小/);f.bridge.canThreadUseModel=()=>false;await expect(f.run()).rejects.toThrow(/供应商/);expect(f.calls.some(call=>call.method==='thread/fork')).toBe(false);}
    finally{await f.dispose();}
  });
  it('archives old large legacy outputs, preserving the source and two recent turns',async()=>{
    const f=await fixture(); let childId:string|undefined;
    try{
      const original=await f.source();state.size=largeThreadForkBytes;
      const result=await f.run() as {thread:{id:string}};childId=result.thread.id;
      expect(f.calls.map(call=>call.method)).toEqual(['thread/resume']);
      const target=f.calls[0].params.path;const body=await fs.readFile(target,'utf8');
      expect(body).toContain('已精简');expect(body).toContain('two:'+ 'x'.repeat(200000));expect(body).toContain('three:'+ 'x'.repeat(200000));
      expect(await fs.readFile(state.source!,'utf8')).toBe(original);
      const archive=toolArchivePath(toolArchiveRoot(serverConfig.dataDir,'admin'),childId);
      expect(gunzipSync(await fs.readFile(archive)).toString()).toContain('one:'+ 'x'.repeat(200000));
      expect((await fs.stat(archive)).mode&0o777).toBe(0o600);
      expect(state.checked[0]).toBe(64*1024*1024);
    }finally{
      if(childId){const archive=toolArchivePath(toolArchiveRoot(serverConfig.dataDir,'admin'),childId);await Promise.all([archive,archive+'.json'].map(file=>fs.unlink(file).catch(()=>{})));}
      await f.dispose();
    }
  });
  it('does not rewrite paginated history or bypass a failed memory budget',async()=>{
    const f=await fixture();
    try{const original=await f.source(false);state.size=largeThreadForkBytes;state.rejectBudget=true;await expect(f.run()).rejects.toThrow(/memory/);expect(f.calls).toHaveLength(0);expect(await fs.readFile(state.source!,'utf8')).toBe(original);}
    finally{await f.dispose();}
  });
});
