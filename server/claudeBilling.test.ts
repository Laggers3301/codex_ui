import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {ClaudeSessionStorage} from './claudeSessionStorage.js';
import {readClaudeBilling,cachedClaudeBilling} from './claudeBilling.js';
import {claudeTokenLeaderboard,mergeAccountLeaderboards,presentLeaderboard} from './routes.js';

it('backfills native completed/failed usage once per turn, excludes imported and inherited context, and caches the isolated worker',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-billing-')),storage=new ClaudeSessionStorage(root);
  try{
    storage.db.prepare('INSERT INTO conversations VALUES(?,?)').run('source',JSON.stringify({userId:'lzc'}));
    storage.db.prepare('INSERT INTO conversations VALUES(?,?)').run('fork',JSON.stringify({userId:'other',parentThreadId:'source',inheritedTurnCount:1}));
    const usage={input_tokens:2,cache_read_input_tokens:100,cache_creation_input_tokens:20,output_tokens:7,output_tokens_details:{thinking_tokens:3}};
    storage.saveTurn('source',{id:'a',status:'completed',usage,billingModel:'claude-opus-5-5',billingEffort:'high',items:[]});
    storage.saveTurn('source',{id:'a',status:'completed',usage:{...usage,output_tokens:11},billingModel:'claude-opus-5-5',billingEffort:'high',items:[]});
    storage.saveTurn('fork',{id:'import',status:'completed',items:[{type:'agentMessage',text:'copied history'}]});
    storage.saveTurn('fork',{id:'b',status:'failed',usage:{input_tokens:10,output_tokens:1},items:[]});
    const a=readClaudeBilling(root),b=readClaudeBilling(root);expect(a).toBe(b);
    const entries=await a;expect(entries).toHaveLength(2);
    expect(entries.find(e=>e.id==='a')).toMatchObject({userId:'lzc',model:'claude-opus-5-5',effort:'high',inputTokens:122,cachedInputTokens:100,cacheWriteInputTokens:20,outputTokens:11,reasoningOutputTokens:3,totalTokens:133});
    expect(entries.find(e=>e.id==='b')).toMatchObject({userId:'other',model:'Claude (legacy)',totalTokens:11});
    expect(await readClaudeBilling(root)).toBe(entries);expect(cachedClaudeBilling(root)).toBe(entries);
    const at=Math.floor(entries[0].at/1000),window={startAt:at-10,resetAt:at+10,resetWindowMins:null};
    const claude=claudeTokenLeaderboard(entries,window);expect(claude.currentCycle.totalTokens).toBe(144);expect(claude.lifetime.totalTokens).toBe(144);
    expect(claude.currentCycle.users.find(u=>u.userId==='lzc')?.models[0]).toMatchObject({model:'claude-opus-5-5',totalTokens:133,quotaPercent:null});
    expect(claudeTokenLeaderboard(entries,{...window,startAt:at+20,resetAt:at+30}).currentCycle.totalTokens).toBe(0);
    const board=presentLeaderboard(mergeAccountLeaderboards([claude],[{id:'reclaude',kind:'api-provider',label:'ReClaude',sessionsRoot:'',quota:{}} as never]));
    expect(board.quotaAccountCount).toBe(0);expect(board.currentCycle.users.every(u=>u.poolQuotaPercent===null)).toBe(true);
  }finally{storage.close();fs.rmSync(root,{recursive:true,force:true});}
},15000);
