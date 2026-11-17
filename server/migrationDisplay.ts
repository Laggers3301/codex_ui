import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate as yieldNow} from 'node:timers/promises';
import type {ClaudeSessionStorage} from './claudeSessionStorage.js';
import {readIndexedThreadPage,indexedHistoryEnd} from './threadEventIndex.js';
type Row=Record<string,any>;
const budget=8*1024*1024;
const builds=new Map<string,Promise<void>>();
const boundaries=new WeakMap<ClaudeSessionStorage,Map<string,number>>();
/** Immutable import boundary: use the saved rowid for new transfers and resolve
 * legacy OFFSET metadata just once, without loading any message bodies. */
export function importedTurnBoundary(storage:ClaudeSessionStorage,transfer:Row):number|null{
  let cache=boundaries.get(storage);if(!cache){cache=new Map();boundaries.set(storage,cache);}
  const key=`${transfer.id}:${transfer.targetThreadId}:${transfer.importedCount}`;
  const previous=cache.get(key);if(previous!==undefined)return previous;
  const saved=transfer.importedBoundaryRowid;
  const row=Number.isSafeInteger(saved)&&saved>0
    ?storage.db.prepare('SELECT rowid FROM turns WHERE thread_id=? AND rowid=?').get(transfer.targetThreadId,saved)
    :storage.db.prepare('SELECT rowid FROM turns WHERE thread_id=? ORDER BY created_at,rowid LIMIT 1 OFFSET ?').get(transfer.targetThreadId,transfer.importedCount-1);
  if(!row)return null;
  const boundary=Number(row.rowid);cache.set(key,boundary);return boundary;
}
export function displayPath(storage:ClaudeSessionStorage,id:string){
  if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('Invalid migration display identity');
  return path.join(storage.directory,'transfers',id,'display.sqlite');
}
export function displayTransfer(storage:ClaudeSessionStorage,target:string,user:string):Row|null{
  if(!storage.db.prepare("SELECT 1 FROM sqlite_master WHERE name='runtime_transfers'").get())return null;
  const found=storage.db.prepare("SELECT body FROM runtime_transfers WHERE json_extract(body,'$.targetThreadId')=? AND json_extract(body,'$.userId')=? AND json_extract(body,'$.phase')='completed'").get(target,user);
  return found?JSON.parse(String(found.body)):null;
}
function ready(file:string){
  if(!fs.existsSync(file))return false;
  const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare("SELECT value FROM meta WHERE key='ready'").get()?.value==='1';}finally{db.close();}
}
/** Freeze the source's typed UI history separately from the portable model input.
 * Pages/items are bounded; repeated user headers on item pages merge by ID. */
export async function captureMigrationDisplay(storage:ClaudeSessionStorage,transfer:Row,read:(before:number,cursor?:string)=>Promise<any>,onProgress?:(items:number)=>void){
  const key=displayPath(storage,transfer.id),pending=builds.get(key);if(pending)return pending;
  const work=buildDisplay(storage,transfer,read,onProgress);builds.set(key,work);
  try{await work;}finally{builds.delete(key);}
}
async function buildDisplay(storage:ClaudeSessionStorage,transfer:Row,read:(before:number,cursor?:string)=>Promise<any>,onProgress?:(items:number)=>void){
  const file=displayPath(storage,transfer.id);if(ready(file))return;
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const partial=file+'.partial';
  if(fs.existsSync(partial))fs.unlinkSync(partial);
  const db=new DatabaseSync(partial);fs.chmodSync(partial,0o600);
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE items(seq INTEGER PRIMARY KEY,turn_id TEXT,item_id TEXT,header TEXT,body TEXT,bytes INTEGER,UNIQUE(turn_id,item_id));CREATE TABLE mappings(seq INTEGER PRIMARY KEY,last_user INTEGER);');
  const ids=new Map<string,number>(),turns=new Map<string,number>();let lastUser=-1,maxSeq=-1;
  const insertMap=db.prepare('INSERT INTO mappings VALUES(?,?)');
  db.exec('BEGIN');
  for(const r of storage.db.prepare("SELECT seq,turn_id,json_extract(body,'$.sourceId') source_id,json_extract(body,'$.role') role FROM runtime_transfer_items WHERE transfer_id=? ORDER BY seq").iterate(transfer.id)){
    const n=Number(r.seq);if(r.source_id)ids.set(String(r.source_id),n);if(r.turn_id)turns.set(String(r.turn_id),n);if(r.role==='user')lastUser=n;insertMap.run(n,lastUser);maxSeq=n;
  }db.exec('COMMIT');
  const insert=db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?) ON CONFLICT(turn_id,item_id) DO UPDATE SET seq=excluded.seq,header=excluded.header,body=excluded.body,bytes=excluded.bytes');
  let seq=-1,before=0,processed=0,cursor:string|undefined;const visited=new Set<string>();
  try{
    for(;;){
      const key=JSON.stringify([before,cursor]);if(visited.has(key))throw Error('Migration display pagination did not advance');visited.add(key);
      const page=await read(before,cursor);const pageTurns=page.thread?.turns??[];
      db.exec('BEGIN');
      try{for(const t of [...pageTurns].reverse()){
        const {items,...header}=t;
        let portableSeq=transfer.sourceRuntime==='codex'?turns.get(String(t.sourceTurnId??t.id)):undefined;
        if(portableSeq===undefined&&transfer.sourceRuntime==='claude-code'){
          const meta=storage.db.prepare("SELECT json_extract(body,'$.nativeMessageId') uuid FROM turns WHERE thread_id=? AND id=?").get(transfer.sourceThreadId,t.id);
          if(meta?.uuid)portableSeq=ids.get(String(meta.uuid));
        }
        if(t.id===transfer.sourceTurnId)portableSeq=maxSeq;
        for(const item of [...(items??[])].reverse()){
          if(typeof item.id!=='string')throw Error('Migration source item has no stable ID');
          const body=JSON.stringify(item),bytes=Buffer.byteLength(body);if(bytes>budget)throw Error('迁移展示中的单条记录超过安全预览预算。');
          insert.run(seq--,String(t.id),item.id,JSON.stringify({...header,portableSeq}),body,bytes);
          processed++;
        }
      }db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
      onProgress?.(processed);
      if(!page.history?.hasOlder)break;
      before=page.history.nextBefore;cursor=page.history.nextCursor??undefined;
      await yieldNow();
    }
    db.prepare('INSERT INTO meta VALUES(?,?)').run('ready','1');
  }finally{db.close();}
  fs.renameSync(partial,file);
}
// A display database is written once and then renamed into place as read-only history, so the
// number of items in it is fixed for a given file version. The unindexed COUNT(*) walked the
// whole table (hundreds of ms on a long import) on every page open; remember it per file version.
const itemCounts=new Map<string,{key:string;total:number}>();
function itemCount(db:DatabaseSync):number{
  let key='';const file=db.location();
  if(!file)return Number(db.prepare('SELECT COUNT(*) n FROM items').get()!.n);
  try{const info=fs.statSync(file);key=`${info.ino}:${info.size}:${info.mtimeMs}`;}catch{return Number(db.prepare('SELECT COUNT(*) n FROM items').get()!.n);}
  const hit=itemCounts.get(file);if(hit?.key===key)return hit.total;
  const total=Number(db.prepare('SELECT COUNT(*) n FROM items').get()!.n);
  if(itemCounts.size>=256)itemCounts.delete(itemCounts.keys().next().value!);
  itemCounts.set(file,{key,total});return total;
}
function projection(storage:ClaudeSessionStorage,transfer:Row,before:number,limit:number,db:DatabaseSync){
  const total=itemCount(db);
  const rows=db.prepare('SELECT * FROM items ORDER BY seq DESC LIMIT ? OFFSET ?').all(Math.min(100,limit),Math.max(0,before));
  const selected:typeof rows=[];let bytes=0;
  for(const row of rows){if(selected.length&&bytes+Number(row.bytes)>budget)break;selected.push(row);bytes+=Number(row.bytes);}
  const turns=new Map<string,Row>();
  for(const row of selected.reverse()){
    let turn=turns.get(String(row.turn_id));if(!turn){
      const {portableSeq,...header}=JSON.parse(String(row.header));let id=`migration-history:${transfer.id}:${row.turn_id}`;
      if(Number.isSafeInteger(portableSeq)){
        if(transfer.sourceRuntime==='claude-code'){
          const m=db.prepare('SELECT last_user FROM mappings WHERE seq=?').get(portableSeq);if(m&&Number(m.last_user)>=0)id=`migration-${transfer.id}-${m.last_user}`;
        }else{
          const m=storage.db.prepare('SELECT id FROM turns WHERE thread_id=? ORDER BY created_at,rowid LIMIT 1 OFFSET ?').get(transfer.targetThreadId,portableSeq);if(m)id=String(m.id);
        }
      }
      turn={...header,id,sourceTurnId:row.turn_id,historicalImport:true,items:[]};turns.set(String(row.turn_id),turn!);
    }
    turn!.items.push({...JSON.parse(String(row.body)),historicalImport:true});
  }
  return {turns:[...turns.values()],history:{totalItems:total,returnedItems:selected.length,before,nextBefore:before+selected.length,hasOlder:before+selected.length<total,nextCursor:null}};
}
export async function readMigrationDisplay(storage:ClaudeSessionStorage,transfer:Row,summary:Row,before:number,limit:number,nativeFile?:string,indexId?:string,maxEndOffset?:number){
  const file=displayPath(storage,transfer.id);if(!ready(file))return null;
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    const total=itemCount(db);
    let ownCount:number,own:any;
    if(transfer.sourceRuntime==='claude-code'){
      if(!nativeFile)throw Error('Migrated native history is missing');
      const last=db.prepare('SELECT last_user FROM mappings ORDER BY seq DESC LIMIT 1').get();
      const boundary=await indexedHistoryEnd(nativeFile,indexId??transfer.targetThreadId,`migration-${transfer.id}-${last!.last_user}`);
      own=await readIndexedThreadPage(nativeFile,indexId??transfer.targetThreadId,{before,limit,minStartOffset:boundary,maxEndOffset,sessionsRoot:path.dirname(nativeFile)});
      ownCount=own.history.totalItems;
    }else{
      const boundary=importedTurnBoundary(storage,transfer);if(boundary===null)throw Error('Migration display boundary is missing');
      ownCount=storage.turnCount(transfer.targetThreadId,boundary);
      const turns=before<ownCount?storage.turns(transfer.targetThreadId,Math.min(limit,ownCount-before),before,budget,boundary):[];
      own={thread:{turns},history:{nextBefore:before+turns.length,returnedItems:turns.length,nextCursor:null}};
    }
    if(before<ownCount)return {thread:{...summary,turns:own.thread.turns},history:{...own.history,totalItems:total+ownCount,hasOlder:true}};
    const p=projection(storage,transfer,Math.max(0,before-ownCount),limit,db);
    return {thread:{...summary,turns:p.turns},history:{...p.history,before,nextBefore:ownCount+p.history.nextBefore,totalItems:ownCount+total}};
  }finally{db.close();}
}
export function migrationDisplayItem(storage:ClaudeSessionStorage,transfer:Row,itemId:string){
  const file=displayPath(storage,transfer.id);if(!ready(file))return null;
  const db=new DatabaseSync(file,{readOnly:true});try{const row=db.prepare('SELECT body FROM items WHERE item_id=? LIMIT 1').get(itemId);return row?JSON.parse(String(row.body)):null;}finally{db.close();}
}
