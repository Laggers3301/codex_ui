import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {ClaudeSessionStorage,type ClaudeConversation} from './claudeSessionStorage.js';
import {claudeMessageUsage,ClaudeContextUsageStore} from './claudeContextUsage.js';
const message=(input=2)=>({type:'assistant',timestamp:'2026-11-06T05:55:53Z',message:{id:'message-1',model:'claude-opus-5-5',usage:{input_tokens:input,cache_creation_input_tokens:20044,cache_read_input_tokens:12947,output_tokens:244,output_tokens_details:{thinking_tokens:60}}}});
it('uses the latest request including cache, never adds reasoning twice or accepts subagent/aggregate totals',()=>{
  const snapshot=claudeMessageUsage(message())!;expect(snapshot.inputTokens+snapshot.cacheReadTokens+snapshot.cacheWriteTokens+snapshot.outputTokens).toBe(33237);
  expect(snapshot.thinkingTokens).toBe(60);expect(snapshot.contextWindow).toBe(1000000);expect(snapshot.windowSource).toBe('model_default');
  expect(claudeMessageUsage({...message(),parent_tool_use_id:'subagent'})).toBeNull();expect(claudeMessageUsage({type:'result',usage:{input_tokens:999999},modelUsage:{'claude-opus-5-5':{inputTokens:999999}}})).toBeNull();
});
it('recovers old native sessions, deduplicates snapshots and does not reuse usage after context rewriting',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-context-usage-')),storage=new ClaudeSessionStorage(path.join(root,'data'));
  try{
    const configRoot=path.join(root,'config'),cwd=path.join(root,'work'),id='11111111-1111-4111-8111-111111111111';fs.mkdirSync(cwd);
    const folder=path.join(configRoot,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'));fs.mkdirSync(folder,{recursive:true});
    const row={id:'thread',nativeSessionId:id,configRoot,cwd,userId:'alice',projectId:'p',model:'reclaude-opus@1',initialized:true} as ClaudeConversation;
    fs.writeFileSync(path.join(folder,id+'.jsonl'),[message(),message()].map(x=>JSON.stringify(x)).join('\n')+'\n');
    const service=new ClaudeContextUsageStore(storage);let status=await service.read(row);expect(status.usedTokens).toBe(33237);expect(status.claudeUsage?.model).toBe('claude-opus-5-5');
    service.save(row.id,row.nativeSessionId,{...claudeMessageUsage(message(10))!,at:'2026-11-06T06:00:00Z',contextWindow:200000,windowSource:'runtime'});
    status=await service.read(row);expect(status.usedTokens).toBe(33245);expect(status.contextWindow).toBe(200000);expect(status.claudeUsage?.windowSource).toBe('runtime');
    expect((await service.read({...row,contextHandoff:{preparedAt:'2026-11-06T07:00:00Z'} as any})).usedTokens).toBeNull();
    fs.appendFileSync(path.join(folder,id+'.jsonl'),JSON.stringify({type:'system',subtype:'compact_boundary',timestamp:'2026-11-06T08:00:00Z'})+'\n');
    expect((await service.read(row)).usedTokens).toBeNull();
  }finally{storage.close();fs.rmSync(root,{recursive:true,force:true});}
});
