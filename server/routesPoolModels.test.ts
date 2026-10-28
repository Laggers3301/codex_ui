import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';

// No official CLI, account authorization or model requests in this HTTP fixture.
vi.mock('node:child_process', async original => {
  const real=await original<typeof import('node:child_process')>();
  return {...real,
    execFileSync:vi.fn(()=>JSON.stringify({models:[]})),
    execFile:vi.fn((...args:unknown[])=>{const callback=args.at(-1);if(typeof callback==='function')callback(new Error('fixture: native provider disabled'));return new EventEmitter();})};
});
import { execFileSync } from 'node:child_process';
import { AccountPoolBridge } from './accountPoolBridge.js';
import type { CodexBridge } from './codexBridge.js';
import type { ProjectStore } from './db.js';
import { invalidateModelCatalogCache, registerRoutes } from './routes.js';

it('serves installed pool catalogs even when the default account is stale or the CLI probe fails',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pool-models-'));
  const homes=['old','new'].map(id=>{const home=path.join(directory,id);fs.mkdirSync(home);return home;});
  const model=(slug:string)=>({slug,display_name:slug,visibility:'list',shell_type:'unified_exec',priority:3,supported_reasoning_levels:[{effort:'low'},{effort:'max'}]});
  for(let i=0;i<homes.length;i++)fs.writeFileSync(path.join(homes[i],'model-catalog-gpt-5.6-sol-long-context.json'),JSON.stringify({models:[model('gpt-6.1-sol'),...(i?[model('gpt-6.1-terra')]:[])]}));
  let nativeRequests=0;
  class Fixture extends EventEmitter {
    getPendingServerRequests(){return [];}
    stop(){}
    request(){nativeRequests++;throw new Error('No production/native requests allowed');}
  }
  const pool=new AccountPoolBridge({accounts:homes.map((codexHome,i)=>({id:i?'new':'old',label:i?'new':'old',codexHome})),stateFile:'pool.json'},directory,()=>new Fixture() as unknown as CodexBridge);
  const app=Fastify();
  vi.stubEnv('CODEX_WEB_EXTRA_MODEL_CATALOGS','');invalidateModelCatalogCache();
  registerRoutes(app,pool as unknown as CodexBridge,{} as ProjectStore,{backgroundIndexing:false,browserTools:false});
  try {
    for(const offline of [false,true]){
      invalidateModelCatalogCache();
      if(offline)vi.mocked(execFileSync).mockImplementationOnce(()=>{throw new Error('offline fixture');});
      const response=await app.inject({method:'GET',url:'/api/models'});
      expect(response.statusCode).toBe(200);
      const data=response.json().data;
      expect(data.filter((m:{model:string})=>m.model==='gpt-6.1-terra')).toHaveLength(2);
      expect(data.filter((m:{runtime?:string})=>m.runtime==='claude-code')).toHaveLength(3);
      expect(data.filter((m:{runtime?:string})=>m.runtime==='claude-code').every((m:{availability:string})=>m.availability==='not-connected')).toBe(true);
      expect(new Set(data.map((m:{id:string})=>m.id)).size).toBe(data.length);
    }
    expect(pool.getBranchRoutingDecision('fixture-thread','gpt-6.1-terra').targetAccount.id).toBe('new');
    await expect(pool.request("thread/start", {model:"reclaude-sonnet"})).rejects.toMatchObject({code:"runtime_not_connected"});
    await expect(pool.startThreadOnAccount("old", {model:"reclaude-sonnet"})).rejects.toMatchObject({code:"runtime_not_connected"});
    await expect(pool.forkThreadOnAccount("old", {model:"reclaude-opus"})).rejects.toMatchObject({code:"runtime_not_connected"});
    expect(nativeRequests).toBe(0);
  } finally {
    await app.close();pool.stop();vi.unstubAllEnvs();invalidateModelCatalogCache();
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
