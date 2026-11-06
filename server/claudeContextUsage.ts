import fs from 'node:fs/promises';
import type {ClaudeSessionStorage,ClaudeConversation} from './claudeSessionStorage.js';
import {locateClaudeHistory} from './claudeSessionStorage.js';
import type {ThreadContextUsage} from './threadContext.js';
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export interface ClaudeContextSnapshot {model:string;messageId:string;inputTokens:number;cacheReadTokens:number;cacheWriteTokens:number;outputTokens:number;thinkingTokens:number|null;contextWindow:number|null;windowSource:'runtime'|'model_default'|'unknown';at:string;}
// Version-specific documented defaults, never a blanket 1M for arbitrary aliases.
export function claudeDefaultWindow(model:string):number|null{
  if(/^claude-(?:opus-(?:5(?:-5)?|4-[678])|sonnet-(?:5(?:-5)?|4-6)|haiku-5-5|fable-5(?:-1)?|mythos-5(?:-1)?)(?:-|$)/.test(model))return 1_000_000;
  if(/^claude-(?:sonnet|haiku)-4-5(?:-|$)/.test(model))return 200_000;
  return null;
}
export function claudeMessageUsage(message:any,at=new Date().toISOString()):ClaudeContextSnapshot|null{
  if(message.parent_tool_use_id||message.type!=='assistant'||!message.message?.id)return null;
  const m=message.message,u=m.usage;if(!u||typeof m.model!=='string'||m.model.startsWith('<'))return null;
  if(![u.input_tokens,u.cache_read_input_tokens??0,u.cache_creation_input_tokens??0,u.output_tokens].every(finite))return null;
  const input=u.input_tokens+(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0);
  if(!input&&!u.output_tokens)return null;
  const window=finite(u.context_window)&&u.context_window>0?u.context_window:claudeDefaultWindow(m.model);
  return {model:m.model,messageId:m.id,inputTokens:u.input_tokens,cacheReadTokens:u.cache_read_input_tokens??0,cacheWriteTokens:u.cache_creation_input_tokens??0,outputTokens:u.output_tokens,thinkingTokens:finite(u.output_tokens_details?.thinking_tokens)?u.output_tokens_details.thinking_tokens:null,contextWindow:window,windowSource:finite(u.context_window)&&u.context_window>0?'runtime':window?'model_default':'unknown',at};
}
export function claudeContextStatus(snapshot:ClaudeContextSnapshot|null,compactedAt:string[]=[]){
  const used=snapshot?snapshot.inputTokens+snapshot.cacheReadTokens+snapshot.cacheWriteTokens+snapshot.outputTokens:null;
  return {runtime:'claude-code' as const,claudeUsage:snapshot,usedTokens:used,contextWindow:snapshot?.contextWindow??null,usedPercent:used!==null&&snapshot?.contextWindow?used/snapshot.contextWindow*100:null,compactTokenLimit:null,effectiveCompactTokenLimit:null,compactAtPercent:null,warningPercent:80,lastTokenCountAt:snapshot?.at??null,compactedAt};
}
export class ClaudeContextUsageStore{
  private cache=new Map<string,{key:string;snapshot:ClaudeContextSnapshot|null;compactedAt:string[]}>();
  constructor(private storage:ClaudeSessionStorage){storage.db.exec('CREATE TABLE IF NOT EXISTS claude_context_usage (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL)');}
  save(threadId:string,sessionId:string,value:ClaudeContextSnapshot){this.storage.db.prepare('INSERT INTO claude_context_usage VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET session_id=excluded.session_id,body=excluded.body').run(threadId,sessionId,JSON.stringify(value));this.cache.delete(threadId);}
  async read(row:ClaudeConversation):Promise<ThreadContextUsage&{runtime:'claude-code';claudeUsage:ClaudeContextSnapshot|null}>{
    const saved=this.storage.db.prepare('SELECT body FROM claude_context_usage WHERE thread_id=? AND session_id=?').get(row.id,row.nativeSessionId);
    let snapshot:ClaudeContextSnapshot|null=saved?JSON.parse(String(saved.body)):null,compactedAt:string[]=[];
    const file=locateClaudeHistory(row.nativeSessionId,[row.configRoot]);
    if(file){
      const stat=await fs.stat(file),key=`${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,cached=this.cache.get(row.id);
      if(cached?.key===key){snapshot=cached.snapshot;compactedAt=cached.compactedAt;}
      else{
        const handle=await fs.open(file,'r');try{
          const start=Math.max(0,stat.size-1024*1024),buffer=Buffer.alloc(stat.size-start);await handle.read(buffer,0,buffer.length,start);
          const lines=buffer.toString('utf8').split('\n');if(start)lines.shift();
          for(const line of lines){let m:any;try{m=JSON.parse(line);}catch{continue;}
            if(m.subtype==='compact_boundary'&&typeof m.timestamp==='string')compactedAt.push(m.timestamp);
            const candidate=claudeMessageUsage(m,typeof m.timestamp==='string'?m.timestamp:stat.mtime.toISOString());
            if(candidate&&(!snapshot||candidate.at>=snapshot.at)){
              if(snapshot?.windowSource==='runtime'&&snapshot.model===candidate.model&&snapshot.messageId===candidate.messageId){candidate.contextWindow=snapshot.contextWindow;candidate.windowSource='runtime';}
              snapshot=candidate;
            }
          }
        }finally{await handle.close();}
        this.cache.set(row.id,{key,snapshot,compactedAt});if(this.cache.size>128)this.cache.delete(this.cache.keys().next().value!);
      }
    }
    const inputChangedAt=[row.contextHandoff?.preparedAt,row.toolOutputArchive?.summary.createdAt,compactedAt.at(-1)].filter((v):v is string=>typeof v==='string').sort().at(-1);
    if(snapshot&&inputChangedAt&&snapshot.at<inputChangedAt)snapshot=null;
    return claudeContextStatus(snapshot,compactedAt);
  }
}
