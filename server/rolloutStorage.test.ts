import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zstdCompressSync} from 'node:zlib';
import {it,expect,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readableRolloutPath,rolloutLogicalStat} from './rolloutStorage.js';

it('losslessly reads compressed histories with a private deduplicated cache and original logical size',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'storage-read-test-'));
  try {
    const file=path.join(root,'rollout-test.jsonl'),raw=Buffer.from('中文 mixed text\n'.repeat(10000));
    await fs.writeFile(file+'.zst',zstdCompressSync(raw));
    const cache=path.join(root,'cache');
    const paths=await Promise.all([readableRolloutPath(file,cache),readableRolloutPath(file,cache)]);
    expect(paths[0]).toBe(paths[1]);expect(await fs.readFile(paths[0])).toEqual(raw);
    expect((await fs.stat(paths[0])).mode&0o777).toBe(0o600);
    expect((await rolloutLogicalStat(file)).size).toBe(raw.length);
    expect(await fs.stat(file).catch(()=>null)).toBeNull();
    await fs.writeFile(file,'new native writer');
    expect(await readableRolloutPath(file,cache)).toBe(file);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

it('rejects corrupt compressed bytes without publishing a partial cache or changing the original',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'storage-corrupt-test-'));
  try {
    const file=path.join(root,'rollout-test.jsonl'),raw=Buffer.from('not zstd');
    await fs.writeFile(file+'.zst',raw);
    await expect(readableRolloutPath(file,path.join(root,'cache'))).rejects.toThrow();
    expect(await fs.readFile(file+'.zst')).toEqual(raw);
    expect(await fs.readdir(path.join(root,'cache'))).toHaveLength(0);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

it('does not rebuild an unchanged compressed index after cache eviction and sub-microsecond timestamp rounding',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'storage-index-rounding-'));
  vi.stubEnv('CODEX_THREAD_INDEX_DB',path.join(root,'index.sqlite'));
  vi.stubEnv('CODEX_WEB_CODEX_SESSION_ROOTS',root);vi.resetModules();
  let cachePath:string|undefined,openSpy:{mockRestore():void}|undefined;
  try{
    const file=path.join(root,'rollout-thread.jsonl');
    const row=(text:string)=>Buffer.from([
      {type:'session_meta',payload:{id:'rounding-thread'}},
      {type:'turn_context',payload:{turn_id:'turn'}},
      {type:'response_item',payload:{type:'message',id:'answer',role:'assistant',content:[{type:'output_text',text}]}}
    ].map(value=>JSON.stringify(value)).join('\n')+'\n');
    await fs.writeFile(file+'.zst',zstdCompressSync(row('answer-a')));
    const index=await import('./threadEventIndex.js');
    await index.readIndexedThreadPage(file,'rounding-thread',{limit:1});
    const database=new DatabaseSync(path.join(root,'index.sqlite'),{readOnly:true});
    const state=()=>database.prepare('SELECT inode,mtime_ms,index_generation FROM thread_files WHERE thread_id=?').get('rounding-thread') as {inode:number;mtime_ms:number;index_generation:number};
    const before=state();cachePath=await readableRolloutPath(file);await fs.unlink(cachePath);
    const originalOpen=fs.open.bind(fs);
    openSpy=vi.spyOn(fs,'open').mockImplementation(async(...args:Parameters<typeof fs.open>)=>{
      const handle=await originalOpen(...args);
      if(String(args[0])===file+'.zst'){
        const stat=handle.stat.bind(handle);
        handle.stat=(async()=>{const value=await stat();value.mtimeMs=before.mtime_ms+0.00048828125;return value;}) as typeof handle.stat;
      }
      return handle;
    });
    expect(JSON.stringify(await index.readIndexedThreadPage(file,'rounding-thread',{limit:1}))).toContain('answer-a');
    expect(state()).toEqual(before);
    openSpy?.mockRestore();openSpy=undefined;
    const archiveStat=await fs.stat(file+'.zst');
    await fs.writeFile(file+'.zst',zstdCompressSync(row('answer-b')));
    await fs.utimes(file+'.zst',new Date(),new Date(archiveStat.mtimeMs+2000));
    expect(JSON.stringify(await index.readIndexedThreadPage(file,'rounding-thread',{limit:1}))).toContain('answer-b');
    expect(state().index_generation).toBeGreaterThan(before.index_generation);
    database.close();
  }finally{openSpy?.mockRestore();vi.unstubAllEnvs();if(cachePath)await fs.unlink(cachePath).catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
});

it('discovers, pages, searches and forks a compressed legacy history without changing its source',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'storage-web-test-'));
  vi.stubEnv('CODEX_THREAD_INDEX_DB',path.join(root,'index.sqlite'));
  vi.stubEnv('CODEX_WEB_CODEX_SESSION_ROOTS',root);vi.resetModules();
  try {
    const id='443f9dfc-2692-4920-953e-b04cb2dc6c26',file=path.join(root,`rollout-${id}.jsonl`);
    const rows=[{type:'session_meta',payload:{id,history_mode:'legacy'}},
      {type:'event_msg',payload:{type:'task_started',turn_id:'turn-one'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'保留完整的中文问题'}]}},
      {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'完整回答'}]}},
      {type:'event_msg',payload:{type:'task_complete',turn_id:'turn-one'}}];
    const raw=Buffer.from(rows.map(r=>JSON.stringify(r)).join('\n')+'\n'),zipped=zstdCompressSync(raw);
    await fs.writeFile(file+'.zst',zipped);
    const fallback=await import('./threadFallback.js'),index=await import('./threadEventIndex.js');
    expect(await fallback.findThreadJsonlPathById(id,root)).toBe(file);
    const page=await index.readIndexedThreadPage(file,id,{limit:1});
    expect(JSON.stringify(page)).toContain('完整回答');
    expect(JSON.stringify(await index.searchIndexedThreads([{threadId:id,filePath:file}],'中文问题'))).toContain('中文问题');
    const {copyLargeThreadBranch}=await import('./largeThreadFork.js');
    const target=path.join(root,'target');await fs.mkdir(target);
    const fork=await copyLargeThreadBranch({sourcePath:file,sourceSessionsRoot:root,sourceThreadId:id,lastTurnId:'turn-one',targetSessionsRoot:target,cwd:root});
    expect(await fs.readFile(fork.path,'utf8')).toContain('保留完整的中文问题');
    expect(await fs.readFile(file+'.zst')).toEqual(zipped);
    expect(await fs.stat(file).catch(()=>null)).toBeNull();
  } finally {vi.unstubAllEnvs();await fs.rm(root,{recursive:true,force:true});}
});
