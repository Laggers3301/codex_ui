import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { readRolloutText, rolloutReadStream, MAX_FULL_HISTORY_BYTES } from './rolloutStorage.js';
import { readThreadFromJsonl, threadJsonlMatchesSearch } from './threadFallback.js';
import * as fallback from './threadFallback.js';
import { registerRoutes } from './routes.js';
import { ProjectStore } from './db.js';
import { serverConfig } from './config.js';
import { copyLargeThreadBranch } from './largeThreadFork.js';
import type { CodexBridge } from './codexBridge.js';
// @ts-expect-error Native ESM search worker implementation
import { ChatSearchStore } from './chatSearchStore.mjs';
import { DatabaseSync } from 'node:sqlite';

vi.mock('./threadFallback.js', async () => {
  const actual=await vi.importActual<typeof import('./threadFallback.js')>('./threadFallback.js');
  return {...actual,findThreadJsonlPathById:vi.fn(),
    readThreadFromJsonl:(file:string,id:string,root?:string,options?:Parameters<typeof actual.readThreadFromJsonl>[3])=>actual.readThreadFromJsonl(file,id,root??path.dirname(file),options)};
});
const lines = (records: unknown[]) => records.map(r=>JSON.stringify(r)).join('\n')+'\n';
const header = {type:'session_meta',payload:{id:'source',history_mode:'legacy'}};

it('refuses an oversized whole-file read and oversized range before constructing the history', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-bounds-'));
  try{
    const file=path.join(root,'rollout-source.jsonl');
    await fs.writeFile(file,lines([header])); await fs.truncate(file,40*1024*1024);
    // Keep failure diagnostics small even against an old unbounded reader.
    const code=async(read:()=>Promise<unknown>)=>{try{await read();return 'resolved';}catch(error){return (error as {code?:string}).code??'other-error';}};
    expect(await code(()=>readRolloutText(file))).toBe('HISTORY_MEMORY_LIMIT');
    expect(await code(()=>readThreadFromJsonl(file,'source',root))).toBe('HISTORY_MEMORY_LIMIT');
    expect(await code(()=>readThreadFromJsonl(file,'source',root,{startOffset:0,endOffset:40*1024*1024}))).toBe('HISTORY_MEMORY_LIMIT');
    expect((await fs.stat(file)).size).toBe(40*1024*1024);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

it('does not retain giant parsed object graphs in the small-thread LRU',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-cache-'));
  try{
    const file=path.join(root,'rollout-source.jsonl');
    await fs.writeFile(file,lines([header,{type:'turn_context',payload:{turn_id:'t'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'x'.repeat(600*1024)}]}}]));
    const a=await readThreadFromJsonl(file,'source',root),b=await readThreadFromJsonl(file,'source',root);
    expect(a).not.toBe(b); expect(a.thread).toEqual(b.thread);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

it('bounds search records and branch archive records without changing the source',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-record-'));
  try{
    const sessions=path.join(root,'sessions');await fs.mkdir(sessions);
    const file=path.join(sessions,'rollout-source.jsonl');
    await fs.writeFile(file,lines([header,{type:'event_msg',payload:{type:'task_started',turn_id:'t'}}]));
    await fs.appendFile(file,'{"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c","output":"');
    for(let i=0;i<17;i++)await fs.appendFile(file,'x'.repeat(1024*1024));
    await fs.appendFile(file,'"}}\n'+lines([{type:'event_msg',payload:{type:'task_complete',turn_id:'t'}}]));
    const before=await fs.stat(file);
    await expect(threadJsonlMatchesSearch(file,'missing',sessions)).rejects.toMatchObject({code:'HISTORY_MEMORY_LIMIT'});
    await expect(copyLargeThreadBranch({sourcePath:file,sourceSessionsRoot:sessions,sourceThreadId:'source',lastTurnId:'t',targetSessionsRoot:path.join(root,'target'),cwd:root,toolArchiveRoot:path.join(root,'archive')})).rejects.toThrow(/超大/);
    expect((await fs.stat(file)).size).toBe(before.size);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

it('refuses large rendered exports before runtime hydration and streams byte-identical source only to its owner',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-export-'));
  const store=new ProjectStore(path.join(root,'store.sqlite'));const app=Fastify();
  const originalRoot=serverConfig.projectRoot;
  serverConfig.projectRoot=root;
  try{
    const file=path.join(root,'rollout-source.jsonl');
    await fs.writeFile(file,lines([header]));await fs.appendFile(file,'x'.repeat(MAX_FULL_HISTORY_BYTES+1));
    vi.mocked(fallback.findThreadJsonlPathById).mockResolvedValue(file);
    const project=store.createProject({name:'fixture',rootPath:root});
    store.registerThreadOwner({threadId:'source',userId:'admin',projectId:project.id,rootPath:root});
    const bridge=Object.assign(new EventEmitter(),{request:vi.fn(async()=>{throw Error('Full runtime history must not be loaded');}),getPendingServerRequests:()=>[]});
    registerRoutes(app,bridge as unknown as CodexBridge,store,{backgroundIndexing:false});
    const response=await app.inject({method:'POST',url:`/api/projects/${project.id}/threads/source/export`,payload:{format:'json'}});
    expect(response.statusCode).toBe(413);expect(bridge.request).not.toHaveBeenCalled();
    const download=await app.inject({url:response.json().nativeHistoryUrl});
    expect(download.statusCode).toBe(200);
    const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
    expect(digest(download.rawPayload)).toBe(digest(await fs.readFile(file)));
    expect(download.headers['cache-control']).toBe('private, no-store');
    const forbidden=await app.inject({url:`/api/projects/${project.id}/threads/other/history-source`});
    expect(forbidden.statusCode).toBe(403);
    // Ordinary small histories keep the previous two rendered export formats.
    await fs.writeFile(file,lines([header,{type:'turn_context',payload:{turn_id:'t'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'small export intact'}]}}]));
    for(const format of ['markdown','json']){
      const small=await app.inject({method:'POST',url:`/api/projects/${project.id}/threads/source/export`,payload:{format,outputPath:root}});
      expect(small.statusCode,small.body).toBe(200);
      expect(await fs.readFile(small.json().data.path,'utf8')).toContain('small export intact');
      expect(bridge.request).not.toHaveBeenCalled();
    }
    vi.mocked(fallback.findThreadJsonlPathById).mockResolvedValue(null);
    const absent=await app.inject({url:`/api/threads/source?projectId=${project.id}`});
    expect(absent.statusCode).toBe(503);expect(bridge.request).not.toHaveBeenCalled();
  }finally{serverConfig.projectRoot=originalRoot;await app.close();store.close();await fs.rm(root,{recursive:true,force:true});}
});

it('searches complete long message text and returns bounded snippets, including matches near the end',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'history-search-'));
  const source=new DatabaseSync(path.join(root,'source.sqlite'));let search:any;
  try{
    source.exec('CREATE TABLE thread_files(thread_id TEXT PRIMARY KEY,file_path TEXT,inode INTEGER,size INTEGER,indexed_offset INTEGER,updated_at INTEGER,mtime_ms REAL,metadata_line TEXT);CREATE TABLE thread_records(thread_id TEXT,ordinal INTEGER,record_id TEXT,turn_id TEXT,kind TEXT,search_text TEXT,PRIMARY KEY(thread_id,ordinal));');
    source.prepare('INSERT INTO thread_files VALUES(?,?,?,?,?,?,?,?)').run('s','/s',1,1,1,1,1,'{}');
    source.prepare('INSERT INTO thread_records VALUES(?,?,?,?,?,?)').run('s',1,'item','turn','user','x'.repeat(128*1024)+' 独特命中 😀 end');
    search=new ChatSearchStore(path.join(root,'source.sqlite'),path.join(root,'search.sqlite'));await search.sync();
    const owners=[{threadId:'s',projectId:'p',rootPath:'/',createdAt:'2026-01-01',updatedAt:'2026-01-01'}];
    for(const query of ['独特命中','😀']){
      const result=search.search(owners,query);expect(result.total).toBe(1);
      expect(result.data[0].searchMatch.snippet).toContain(query);expect(result.data[0].searchMatch.snippet.length).toBeLessThan(300);
      expect(search.searchThreadHits('s',query).data[0].snippet).toContain(query);
    }
  }finally{search?.close();source.close();await fs.rm(root,{recursive:true,force:true});}
});
