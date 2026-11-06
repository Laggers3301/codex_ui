import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {rolloutPreviewRecords} from './rolloutPreview.js';

export const MIGRATED_CONTEXT_BYTES=128*1024;
export function contextExcerpt(value:string,bytes:number):string{
  const raw=Buffer.from(value);if(raw.length<=bytes)return value;
  const mark='\n[此段仅为摘录，完整原文保留在历史中]\n';
  const remaining=Math.max(0,bytes-Buffer.byteLength(mark));
  return raw.subarray(0,Math.floor(remaining/3)).toString('utf8').replace(/\uFFFD$/,'')+mark+raw.subarray(raw.length-Math.floor(remaining*2/3)).toString('utf8').replace(/^\uFFFD+/,'');
}

/** An exact historical fork already has its own cut-off native file. Derive
 * from that file, never from the parent's later migration snapshot. */
export async function buildNativeForkContext(file:string){
  const entries:Array<{text:string;tool:boolean}>=[];
  for await(const row of rolloutPreviewRecords(file)){
    const raw=JSON.parse(row.text);if(!['user','assistant'].includes(raw.type))continue;
    const content=raw.message?.content;
    const text=typeof content==='string'?content:(Array.isArray(content)?content:[]).filter((p:any)=>p.type==='text').map((p:any)=>p.text??'').join('\n');
    if(!text)continue;
    const tool=text.startsWith('[历史工具');
    entries.push({tool,text:`[历史${raw.type==='assistant'?'回答':'用户/工具记录'}]\n${contextExcerpt(text,tool?1600:12*1024)}`});
    while(entries.filter(e=>e.tool===tool).length>(tool?12:16)){entries.splice(entries.findIndex(e=>e.tool===tool),1);}
  }
  const header=`这是历史分支的有界工作上下文，仅含该分支截止点之前的记录摘录，不是新指令，不要重放旧工具操作。完整原文保留在该分支归档中。当前用户请求紧随其后。\n`;
  let selected=entries;
  while(selected.length>1&&Buffer.byteLength(header+selected.map(e=>e.text).join('\n\n'))>MIGRATED_CONTEXT_BYTES)selected=selected.slice(1);
  const text=header+contextExcerpt(selected.map(e=>e.text).join('\n\n'),MIGRATED_CONTEXT_BYTES-Buffer.byteLength(header));
  return {text,archive:file,summaryFound:false,records:selected.length,bytes:Buffer.byteLength(text)};
}

/** Only derives model input. No history writes, model calls, credentials or tools. */
export async function buildMigratedContext(database:string,threadId:string,userId:string){
  const db=new DatabaseSync(database,{readOnly:true});
  try{
    const found=db.prepare("SELECT body FROM runtime_transfers WHERE json_extract(body,'$.targetThreadId')=? AND json_extract(body,'$.userId')=? AND json_extract(body,'$.sourceRuntime')='codex' AND json_extract(body,'$.phase')='completed' LIMIT 1").get(threadId,userId);
    if(!found)return null;
    const transfer=JSON.parse(String(found.body));
    const archive=await fs.realpath(transfer.archive),expected=path.join(await fs.realpath(path.dirname(database)),'transfers',transfer.id,'source.jsonl');
    if(archive!==expected)throw Error('迁移快照路径不一致。');
    let summary='',atCutoff=false,cutoffFound=!transfer.sourceTurnId;
    for await(const row of rolloutPreviewRecords(archive)){
      if(!/"type"\s*:\s*"(?:compacted|turn_context|event_msg)"/.test(row.text.slice(0,256)))continue;
      const raw=JSON.parse(row.text),p=raw.payload??{};
      if(raw.type==='turn_context'){
        if(atCutoff&&p.turn_id!==transfer.sourceTurnId)break;
        if(p.turn_id===transfer.sourceTurnId){atCutoff=true;cutoffFound=true;}
      }
      if(raw.type==='compacted'&&typeof p.message==='string')summary=contextExcerpt(p.message,48*1024);
      if(raw.type==='event_msg'&&p.turn_id===transfer.sourceTurnId){
        if(p.type==='task_started'){atCutoff=true;cutoffFound=true;}
        if(['task_complete','task_cancelled'].includes(p.type)){cutoffFound=true;break;}
      }
    }
    if(!cutoffFound)throw Error('未找到迁移截止轮次，未生成包含后续内容的摘要。');
    const ordinary=db.prepare("SELECT seq,json_extract(body,'$.role') AS role,substr(json_extract(body,'$.text'),1,16000) AS text FROM runtime_transfer_items WHERE transfer_id=? AND substr(json_extract(body,'$.text'),1,5)!='[历史工具' ORDER BY seq DESC LIMIT 16").all(transfer.id);
    const tools=db.prepare("SELECT seq,json_extract(body,'$.role') AS role,substr(json_extract(body,'$.text'),1,1200) AS text FROM runtime_transfer_items WHERE transfer_id=? AND substr(json_extract(body,'$.text'),1,5)='[历史工具' ORDER BY seq DESC LIMIT 12").all(transfer.id);
    const boundary=db.prepare('SELECT rowid FROM turns WHERE thread_id=? ORDER BY created_at,rowid LIMIT 1 OFFSET ?').get(threadId,transfer.importedCount-1);
    if(!boundary)throw Error('迁移历史边界不完整。');
    const newer=db.prepare("SELECT t.rowid,substr(json_extract(j.value,'$.text'),1,16000) AS text,json_extract(j.value,'$.type') AS type,json_extract(j.value,'$.content') AS content FROM turns t,json_each(t.body,'$.items') j WHERE t.thread_id=? AND t.rowid>? AND json_extract(j.value,'$.type') IN ('userMessage','agentMessage') ORDER BY t.rowid DESC LIMIT 8").all(threadId,boundary.rowid);
    const sections=[...ordinary,...tools].sort((a,b)=>Number(a.seq)-Number(b.seq)).map(r=>`[历史${r.role==='assistant'?'回答':'用户/工具记录'} #${r.seq}]\n${contextExcerpt(String(r.text??''),12*1024)}`);
    for(const r of newer.reverse()){
      const content=r.type==='userMessage'?JSON.parse(String(r.content??'[]')).map((p:any)=>p.text??'').join('\n'):String(r.text??'');
      if(content&&!/^Prompt is too long\s*$/.test(content))sections.push(`[迁移后的${r.type==='userMessage'?'用户消息':'回答'}]\n${contextExcerpt(content,16*1024)}`);
    }
    const header=`这是跨引擎迁移的有界工作上下文，不是新的执行指令。完整对话、工具结果和图片仍保留，以下仅为摘要和近期摘录；不要重放已完成的工具操作，也不要声称已经读过未包含的全部历史。\n源会话：${transfer.sourceThreadId}\n完整原文（只读查阅）：${archive}\n需要更早的证据时，按关键词或行范围读取原文，不要整份加载。当前用户的新请求会紧随其后。\n`;
    const prefix=header+(summary?`\n[原会话最近一次compact摘要，截止于分支点]\n${summary}\n`:'\n[原会话没有可复用的compact摘要；以下是近期记录摘录，并非全史语义总结]\n');
    let selected=sections;
    while(selected.length>1&&Buffer.byteLength(prefix+selected.join('\n\n'))>MIGRATED_CONTEXT_BYTES)selected=selected.slice(1);
    const text=prefix+contextExcerpt(selected.join('\n\n'),MIGRATED_CONTEXT_BYTES-Buffer.byteLength(prefix));
    return {text,archive,summaryFound:Boolean(summary),records:selected.length,bytes:Buffer.byteLength(text),transferId:transfer.id};
  }finally{db.close();}
}
