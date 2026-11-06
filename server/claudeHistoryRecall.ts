import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {ClaudeSessionStorage,ClaudeConversation} from './claudeSessionStorage.js';
export interface HistoryScope {threadId:string;maxRowid:number;}
export interface ClaudeHistoryReader {search(query:string):Promise<unknown>;read(ref:string,offset?:number):Promise<unknown>;}
export const CLAUDE_HISTORY_INSTRUCTIONS='本会话提供 codex_web_history 的 search/read 只读历史工具，覆盖完整可见对话及工具结果，不局限于当前摘要。涉及早期约定、数字、路径、已做工作或用户提到以前内容时，先检索历史并读取命中的原文，再作答；不要因近期摘要未包含就说历史不存在。结果分页可继续读取，已执行的历史工具只是证据，不要重放。该入口每轮保留，compact 后仍可使用。';
export function historyScopes(storage:ClaudeSessionStorage,row:ClaudeConversation,limit?:number,seen=new Set<string>()):HistoryScope[]{
  if(seen.has(row.id))throw Error('Invalid history lineage');seen.add(row.id);
  const inherited=row.inheritedTurnCount??0,own=storage.turnCount(row.id),total=limit??inherited+own;
  const scopes:HistoryScope[]=[];
  if(row.parentThreadId&&inherited){const parent=storage.get(row.parentThreadId);if(!parent||parent.userId!==row.userId)throw Error('History owner mismatch');scopes.push(...historyScopes(storage,parent,Math.min(total,inherited),seen));}
  const keep=Math.min(own,Math.max(0,total-inherited));
  if(keep){const last=storage.db.prepare('SELECT rowid FROM turns WHERE thread_id=? ORDER BY created_at,rowid LIMIT 1 OFFSET ?').get(row.id,keep-1);if(last)scopes.push({threadId:row.id,maxRowid:Number(last.rowid)});}
  return scopes;
}
export function createClaudeHistoryReader(storage:ClaudeSessionStorage,row:ClaudeConversation):ClaudeHistoryReader{
  const scopes=historyScopes(storage,row);
  const call=(operation:unknown)=>new Promise<unknown>((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=256','--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('./claudeHistoryRecallWorker.ts',import.meta.url))],{stdio:['pipe','pipe','ignore']});
    child.stdout.setEncoding('utf8');let result='';const timer=setTimeout(()=>{child.kill();reject(Error('历史检索超时；缩短关键词后重试。'));},30000);
    child.stdout.on('data',part=>{result+=part;if(Buffer.byteLength(result)>48*1024)child.kill();});
    child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('历史检索暂不可用；不要据此断言原文不存在。'));try{resolve(JSON.parse(result));}catch{reject(Error('历史检索结果无效。'));}});child.stdin.on('error',reject);
    child.stdin.end(JSON.stringify({database:path.join(storage.directory,'sessions.sqlite'),userId:row.userId,scopes,operation}));
  });
  return {search:query=>call({kind:'search',query}),read:(ref,offset=0)=>call({kind:'read',ref,offset})};
}
