import {it,expect,vi,afterEach} from 'vitest';
import {setSidebarThreadHidden,visibleSidebarThreads,reconcileSidebarVisibility} from './sidebarVisibility';
import type {ThreadSummary} from './types';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('removes deleted/archived rows from warm caches, rejects stale responses and allows explicit restore',()=>{
  const storage=new Map<string,string>();
  vi.stubGlobal('window',{localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)},dispatchEvent:vi.fn()});
  vi.stubGlobal('CustomEvent',class{constructor(public type:string,public detail:unknown){}});
  const rows=[{id:'keep'},{id:'deleted'}] as ThreadSummary[];
  storage.set('codex-v2-threads-user-project',JSON.stringify(rows));
  vi.spyOn(Date,'now').mockReturnValue(2000);
  setSidebarThreadHidden('user','project','deleted',true);
  expect(JSON.parse(storage.get('codex-v2-threads-user-project')!).map((x:{id:string})=>x.id)).toEqual(['keep']);
  expect(reconcileSidebarVisibility('user','project',rows,[],1000).map(x=>x.id)).toEqual(['keep']);
  setSidebarThreadHidden('user','project','deleted',false);
  expect(visibleSidebarThreads('user',rows)).toHaveLength(2);
  expect(reconcileSidebarVisibility('user','project',rows,['deleted'],3000).map(x=>x.id)).toEqual(['keep']);
  expect(reconcileSidebarVisibility('user','project',rows,[],4000)).toHaveLength(2);
});
