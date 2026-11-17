import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(roots.splice(0).map(r=>fs.rm(r,{recursive:true,force:true})));});
const id='11111111-1111-4111-8111-111111111111';
const native='22222222-2222-4222-8222-222222222222';
async function setup(){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'rotated-history-'));roots.push(home);
 vi.resetModules();vi.stubEnv('CODEX_HOME',home);vi.stubEnv('CODEX_WEB_ACCOUNT_POOL_FILE','');vi.stubEnv('CODEX_WEB_CODEX_SESSION_ROOTS','');vi.stubEnv('CODEX_THREAD_INDEX_DB',path.join(home,'index.sqlite'));
 const root=path.join(home,'sessions');await fs.mkdir(path.join(root,'old'),{recursive:true});await fs.mkdir(path.join(root,'new'),{recursive:true});
 return {home,root,old:path.join(root,'old',`rollout-2026-10-26-${id}.jsonl`),latest:path.join(root,'new',`rollout-2026-10-29-${id}_${native}.jsonl`)};
}
function lines(thread:string,turn:string,text:string,base?:object){return [
 {type:'session_meta',payload:{id:thread,...(base?{history_mode:'paginated',history_base:base}:{})}},
 {type:'turn_context',payload:{turn_id:turn}},
 {type:'response_item',payload:{type:'message',role:'user',id:`${turn}-user`,content:[{type:'input_text',text}]}},
 {type:'response_item',payload:{type:'message',role:'assistant',id:`${turn}-answer`,content:[{type:'output_text',text:`answer ${text}`}]}},
].map(x=>JSON.stringify(x)+'\n').join('');}
describe('rotated native rollout history',()=>{
 it('selects the newest logical source using metadata, not its native suffix',async()=>{
  const f=await setup();await fs.writeFile(f.old,lines(id,'old','old text'));await fs.utimes(f.old,1,1);
  await fs.writeFile(f.latest,lines(id,'new','latest text'));
  const {findThreadJsonlPathById}=await import('./threadFallback.js');
  expect(await findThreadJsonlPathById(id)).toBe(f.latest);
  expect(await findThreadJsonlPathById(native)).toBeNull();
  expect(await findThreadJsonlPathById(id,undefined,{beforeFile:f.latest})).toBe(f.old);
  expect(await findThreadJsonlPathById(id,undefined,{beforeFile:f.old})).toBeNull();
 });
 it('does not expose a child rollout as its filename-prefix parent',async()=>{
  const f=await setup();await fs.writeFile(f.old,lines(id,'parent','parent text'));await fs.utimes(f.old,1,1);
  await fs.writeFile(f.latest,lines(native,'child','child text'));
  const {findThreadJsonlPathById}=await import('./threadFallback.js');
  expect(await findThreadJsonlPathById(id)).toBe(f.old);
  expect(await findThreadJsonlPathById(native)).toBe(f.latest);
 });
 it('pages from a self-referencing continuation into its unchanged original and loads old output',async()=>{
  const f=await setup();const old=lines(id,'old','old text');await fs.writeFile(f.old,old);await fs.utimes(f.old,1,1);
  await fs.writeFile(f.latest,lines(id,'new','latest text',{thread_id:id,end_byte_offset:Buffer.byteLength(old)}));
  const {readBranchHistoryPage,readBranchHistoryItem}=await import('./branchHistory.js');
  const seen:string[]=[];let cursor:string|undefined;
  for(let i=0;i<8;i++){
   const page=await readBranchHistoryPage(f.latest,id,{limit:1,cursor},()=>true);
   for(const t of page.thread.turns??[])for(const item of t.items??[]){
    const text=item.text??item.content?.map((part:any)=>part.text??'').join('');
    if(text)seen.push(text);
   }
   if(!page.history.hasOlder)break;cursor=page.history.nextCursor;
  }
  expect(seen).toContain('latest text');expect(seen).toContain('old text');
  expect(seen.indexOf('latest text')).toBeLessThan(seen.indexOf('old text'));
  expect((await readBranchHistoryItem(f.latest,id,'old-answer',()=>true))?.text).toBe('answer old text');
  expect(await fs.readFile(f.old,'utf8')).toBe(old);
 });
 it('keeps inherited-history authorization checks',async()=>{
  const f=await setup();const old=lines(id,'old','old text');await fs.writeFile(f.old,old);await fs.utimes(f.old,1,1);
  await fs.writeFile(f.latest,lines(id,'new','latest text',{thread_id:id,end_byte_offset:Buffer.byteLength(old)}));
  const {readBranchHistoryPage}=await import('./branchHistory.js');
  await expect(readBranchHistoryPage(f.latest,id,{limit:1},()=>false)).rejects.toThrow('无权');
 });
});
