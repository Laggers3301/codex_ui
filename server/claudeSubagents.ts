import fs from 'node:fs/promises';
import path from 'node:path';
import type {ClaudeConversation,ClaudeSessionStorage} from './claudeSessionStorage.js';
import {locateClaudeHistory} from './claudeSessionStorage.js';
import {ClaudeStreamAdapter,claudeVisibleItems} from './claudeStreamAdapter.js';
async function boundedRows(file:string,before=0,cutoff=Infinity,limit=100){
  const handle=await fs.open(file,'r');try{
    const stat=await handle.stat(),end=before||stat.size;
    if(!Number.isSafeInteger(end)||end<0||end>stat.size)throw Error('Invalid Claude history cursor');
    const start=Math.max(0,end-512*1024),buffer=Buffer.alloc(end-start);await handle.read(buffer,0,buffer.length,start);
    let text=buffer.toString('utf8'),offset=start;if(start){const split=text.indexOf('\n');if(split<0)throw Error('单条子代理记录过大，原文保留，请使用文件工具分段读取。');offset+=Buffer.byteLength(text.slice(0,split+1));text=text.slice(split+1);}
    const entries:Array<{row:any;offset:number}>=[];let cursor=offset;
    for(const line of text.split('\n')){try{const value=JSON.parse(line);if(!Number.isFinite(cutoff)||Date.parse(value.timestamp)<=cutoff)entries.push({row:value,offset:cursor});}catch{}cursor+=Buffer.byteLength(line)+1;}
    const selected=entries.slice(-Math.max(1,Math.min(100,limit))),next=entries.length>selected.length?selected[0].offset:offset;
    return {rows:selected.map(r=>r.row),before:next,hasOlder:next>0};
  }finally{await handle.close();}
}
type FileRecord={id:string;file:string;cutoff:number;inherited:boolean;updatedAt:string};
export async function claudeForkCutoff(file:string):Promise<number|null>{
  try{const page=await boundedRows(file);let latest:number|null=null;
    for(const row of page.rows)if(['user','assistant'].includes(row.type)&&Number.isFinite(Date.parse(row.timestamp)))latest=Math.max(latest??0,Date.parse(row.timestamp));return latest;
  }catch{return null;} // Optional directory metadata must not invalidate a completed native fork.
}
export async function claudeSubagentFiles(storage:ClaudeSessionStorage,row:ClaudeConversation,cutoff=Infinity,seen=new Set<string>()):Promise<FileRecord[]>{
  if(seen.has(row.id))throw Error('Invalid Claude lineage');seen.add(row.id);
  const sources=[{native:row.nativeSessionId,cutoff}];
  if(row.contextHandoff)sources.push({native:row.contextHandoff.sourceSessionId,cutoff:Math.min(cutoff,Date.parse(row.contextHandoff.preparedAt))});
  const result:FileRecord[]=[];
  for(const source of sources){
    const native=locateClaudeHistory(source.native,[row.configRoot]);if(!native)continue;
    const folder=path.join(path.dirname(native),source.native,'subagents');let entries;try{entries=await fs.readdir(folder,{withFileTypes:true});}catch{continue;}
    for(const entry of entries){if(!entry.isFile()||!/^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(entry.name))continue;
      const file=path.join(folder,entry.name),stat=await fs.stat(file);if(stat.birthtimeMs>source.cutoff)continue;
      result.push({id:entry.name.slice(6,-6),file,cutoff:source.cutoff,inherited:Number.isFinite(source.cutoff),updatedAt:new Date(Math.min(stat.mtimeMs,source.cutoff)).toISOString()});
    }
  }
  if(row.parentThreadId){const parent=storage.get(row.parentThreadId);if(!parent||parent.userId!==row.userId)throw Error('Claude lineage owner mismatch');if(row.inheritedAgentCutoff!==null)result.push(...await claudeSubagentFiles(storage,parent,Math.min(cutoff,row.inheritedAgentCutoff??row.createdAt),seen));}
  return [...new Map(result.map(r=>[r.id,r])).values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export async function claudeSubagentDirectory(storage:ClaudeSessionStorage,row:ClaudeConversation,options:{q?:string;view?:string;cursor?:string;limit?:number;activeRuntime?:boolean}){
  const files=await claudeSubagentFiles(storage,row),q=(options.q??'').toLowerCase(),view=options.view??'all';
  const tasks=new Map((row.nativeTasks??[]).filter(task=>task.kind==='agent').map(task=>[task.id,task]));
  const records=files.map(file=>{
    const task=file.inherited?undefined:tasks.get(file.id),state=!task?'unknown':task.status==='running'&&!options.activeRuntime?'unknown':task.status==='stopped'?'interrupted':task.status;
    return {id:file.id,parentThreadId:row.id,name:task?.description||`Claude · ${file.id}`,updatedAt:file.updatedAt,createdAt:null,lastTaskAt:null,state,inherited:file.inherited};
  });
  for(const task of tasks.values())if(!records.some(record=>record.id===task.id))records.push({id:task.id,parentThreadId:row.id,name:task.description||`Claude · ${task.id}`,updatedAt:new Date(row.updatedAt).toISOString(),createdAt:null,lastTaskAt:null,state:task.status==='running'&&!options.activeRuntime?'unknown':task.status==='stopped'?'interrupted':task.status,inherited:false});
  const filtered=records.filter(r=>(r.id+' '+r.name).toLowerCase().includes(q)&&(view==='active'?r.state==='running':view==='history'?r.state!=='running':true));
  const start=options.cursor?Number(options.cursor):0;if(!Number.isSafeInteger(start)||start<0)throw Error('Invalid Claude subagent cursor');
  const limit=options.limit??40,slice=filtered.slice(start,start+limit),hasMore=start+slice.length<filtered.length;
  const activeCount=records.filter(record=>record.state==='running').length;
  return {data:slice,page:{total:records.length,matchedCount:filtered.length,activeCount,historyCount:records.length-activeCount,unknownCount:records.filter(record=>record.state==='unknown').length,hasMore,nextCursor:hasMore?String(start+slice.length):null}};
}
export async function claudeSubagentPage(storage:ClaudeSessionStorage,row:ClaudeConversation,id:string,before=0,limit=100){
  const found=(await claudeSubagentFiles(storage,row)).find(r=>r.id===id);if(!found)throw Error('当前会话没有此 Claude 子代理。');
  const page=await boundedRows(found.file,before,found.cutoff,limit),adapter=new ClaudeStreamAdapter(id,`claude-agent-page:${page.before}`,()=>{});
  for(const record of page.rows)adapter.accept(record);
  return {thread:{id,name:`Claude · ${id}`,turns:[{id:`claude-agent-page:${page.before}`,status:'unknown',items:claudeVisibleItems([...adapter.items.values()],{includeSubagents:true})}]},history:{totalItems:null,returnedItems:page.rows.length,before,nextBefore:page.before,hasOlder:page.hasOlder,nextCursor:page.hasOlder?String(page.before):null}};
}
