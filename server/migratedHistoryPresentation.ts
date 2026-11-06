import fs from 'node:fs';
import path from 'node:path';
import type {ClaudeSessionStorage,ClaudeConversation} from './claudeSessionStorage.js';
import {MAX_FULL_HISTORY_BYTES} from './rolloutStorage.js';
import {readIndexedThreadPage,readIndexedThreadItem,indexedHistoryEnd} from './threadEventIndex.js';

/** Display the frozen Codex archive, not the portable prompt transcript. Native
 * Claude history remains untouched; new Claude turns stay after the snapshot. */
export async function migratedHistoryPresentation(storage:ClaudeSessionStorage,row:ClaudeConversation,summary:Record<string,any>,before:number,limit:number){
  const db=storage.db;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_transfers'").get())return;
  const found=db.prepare("SELECT body FROM runtime_transfers WHERE json_extract(body,'$.targetThreadId')=? AND json_extract(body,'$.phase')='completed' AND json_extract(body,'$.sourceRuntime')='codex' LIMIT 1").get(row.id);
  if(!found)return;
  const transfer=JSON.parse(String(found.body));
  if(transfer.userId!==row.userId||transfer.projectId!==row.projectId||!transfer.archive||!Number.isSafeInteger(transfer.importedCount)||transfer.importedCount<1)throw new Error('迁移历史归属或数量不一致。');
  const archive=fs.realpathSync(transfer.archive),expected=path.join(fs.realpathSync(storage.directory),'transfers',transfer.id,'source.jsonl');
  if(archive!==expected)throw new Error('迁移历史快照路径不一致。');
  const boundary=db.prepare('SELECT rowid,id FROM turns WHERE thread_id=? ORDER BY created_at,rowid LIMIT 1 OFFSET ?').get(row.id,transfer.importedCount-1);
  if(!boundary)throw new Error('迁移历史映射不完整。');
  const ownCount=storage.turnCount(row.id,Number(boundary.rowid));
  const indexId=`migration-display:${transfer.id}`,end=await indexedHistoryEnd(archive,indexId,transfer.sourceTurnId);
  // Own Claude turns need the frozen source count, not its last tool payload.
  const source=await readIndexedThreadPage(archive,indexId,{before:before<ownCount?Number.MAX_SAFE_INTEGER:Math.max(0,before-ownCount),limit:before<ownCount?1:limit,maxEndOffset:end,sessionsRoot:path.dirname(expected)});
  const total=source.history.totalItems+ownCount;
  if(before<ownCount){
    const turns=storage.turns(row.id,Math.min(limit,ownCount-before),before,MAX_FULL_HISTORY_BYTES,Number(boundary.rowid));
    const next=before+turns.length;
    return {thread:{...summary,turns},history:{totalItems:total,returnedItems:turns.length,before,nextBefore:next,hasOlder:next<total,nextCursor:null}};
  }
  const turns=(source.thread.turns as Array<Record<string,any>>).map(turn=>{
    // Keep native checkpoint IDs so branching a historical answer still uses
    // the imported Claude message at that same source-turn boundary.
    const seq=db.prepare('SELECT MAX(seq) AS n FROM runtime_transfer_items WHERE transfer_id=? AND turn_id=?').get(transfer.id,turn.id)?.n;
    let mappedId:string|undefined;
    if(seq!==null&&seq!==undefined){const position=Number(db.prepare('SELECT COUNT(*) AS n FROM runtime_transfer_items WHERE transfer_id=? AND seq<=?').get(transfer.id,seq)?.n)-1;mappedId=db.prepare('SELECT id FROM turns WHERE thread_id=? ORDER BY created_at,rowid LIMIT 1 OFFSET ?').get(row.id,position)?.id as string|undefined;}
    return {...turn,id:mappedId??`migration-history:${transfer.id}:${turn.id}`,sourceTurnId:turn.id,historicalImport:true,items:turn.items.map((item:Record<string,unknown>)=>({...item,historicalImport:true}))};
  });
  return {thread:{...summary,turns},history:{...source.history,before:before,nextBefore:ownCount+source.history.nextBefore,totalItems:total,nextCursor:null}};
}

export async function migratedHistoryItem(storage:ClaudeSessionStorage,row:ClaudeConversation,itemId:string){
  const found=storage.db.prepare("SELECT body FROM runtime_transfers WHERE json_extract(body,'$.targetThreadId')=? AND json_extract(body,'$.phase')='completed' AND json_extract(body,'$.sourceRuntime')='codex' LIMIT 1").get(row.id);
  if(!found)return null;
  const transfer=JSON.parse(String(found.body));
  if(transfer.userId!==row.userId||transfer.projectId!==row.projectId||!transfer.archive)throw Error('迁移历史归属不一致。');
  const file=fs.realpathSync(transfer.archive),expected=path.join(fs.realpathSync(storage.directory),'transfers',transfer.id,'source.jsonl');
  if(file!==expected)throw Error('迁移历史快照路径不一致。');
  const indexId=`migration-display:${transfer.id}`,end=await indexedHistoryEnd(file,indexId,transfer.sourceTurnId);
  return readIndexedThreadItem(file,indexId,itemId,{maxEndOffset:end});
}
