import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import type {ClaudeSessionStorage,ClaudeConversation} from './claudeSessionStorage.js';
import {locateClaudeHistory} from './claudeSessionStorage.js';
import {contextExcerpt} from './claudeContext.js';

export async function prepareMigratedContext(storage:ClaudeSessionStorage,row:ClaudeConversation,roots:string[]=[row.configRoot]){
  const fromNative=row.contextHandoff?.rebuildFromNative===true;
  if(row.contextHandoff&&!fromNative||!row.initialized)return;
  if(!storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_transfers'").get())return;
  const transfer=storage.db.prepare("SELECT 1 FROM runtime_transfers WHERE json_extract(body,'$.targetThreadId')=? AND json_extract(body,'$.userId')=? AND json_extract(body,'$.sourceRuntime')='codex' AND json_extract(body,'$.phase')='completed'").get(row.id,row.userId);
  if(!transfer&&!fromNative)return;
  const source=locateClaudeHistory(row.nativeSessionId,roots,row.configRoot);if(!source)return;
  const original=await fs.stat(source);if(original.size<=256*1024)return;
  const worker=spawn(process.execPath,['--max-old-space-size=512','--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('./claudeContextWorker.ts',import.meta.url))],{stdio:['pipe','pipe','pipe']});
  worker.stdout.setEncoding('utf8');worker.stderr.setEncoding('utf8');
  const context:any=await new Promise((resolve,reject)=>{
    let output='',error='';const timer=setTimeout(()=>{worker.kill('SIGTERM');reject(Error('迁移上下文整理超时，原历史未修改。'));},120000);
    worker.stdout.on('data',part=>{output+=String(part);if(Buffer.byteLength(output)>192*1024){worker.kill('SIGTERM');reject(Error('迁移上下文输出超限。'));}});
    worker.stderr.on('data',part=>{if(error.length<2000)error+=String(part);});
    worker.once('error',reject);worker.once('close',code=>{clearTimeout(timer);if(code!==0)return reject(Error('迁移上下文整理未完成，原历史未修改。'));try{resolve(JSON.parse(output));}catch{reject(Error('迁移上下文结果无效。'));}});
    worker.stdin.once('error',reject);
    worker.stdin.end(JSON.stringify({database:path.join(storage.directory,'sessions.sqlite'),threadId:row.id,userId:row.userId,...(fromNative?{nativeFile:source}:{})}));
  });
  if(!context)return;
  const after=await fs.stat(source);if(after.size!==original.size||after.mtimeMs!==original.mtimeMs)throw Error('原生历史在整理期间变化，请重试。');
  if(context.bytes>128*1024||typeof context.text!=='string')throw Error('迁移上下文预算无效。');
  const nativeSessionId=randomUUID();storage.reserve(nativeSessionId);
  const originalDirectory=path.join(storage.directory,'context-history',row.id,nativeSessionId);
  await fs.mkdir(originalDirectory,{recursive:true,mode:0o700});
  const originalArchive=path.join(originalDirectory,`${row.nativeSessionId}.jsonl`);
  await fs.copyFile(source,originalArchive);await fs.chmod(originalArchive,0o600);
  const copied=await fs.stat(originalArchive),unchanged=await fs.stat(source);
  if(copied.size!==original.size||unchanged.size!==original.size||unchanged.mtimeMs!==original.mtimeMs)throw Error('原生历史在归档期间变化，未切换模型上下文。');
  if(fromNative){const header=`完整分支原文（只读查阅）：${originalArchive}\n`;context.text=header+contextExcerpt(context.text,128*1024-Buffer.byteLength(header));context.bytes=Buffer.byteLength(context.text);context.archive=originalArchive;}
  const file=path.join(path.dirname(source),`${nativeSessionId}.jsonl`);
  const seed={type:'user',uuid:randomUUID(),parentUuid:null,sessionId:nativeSessionId,cwd:row.cwd,isSidechain:false,timestamp:new Date().toISOString(),version:'2.1.316',message:{role:'user',content:[{type:'text',text:context.text}]}};
  const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify(seed)+'\n');await handle.sync();}finally{await handle.close();}
  const next={...row,nativeSessionId,historyArchive:undefined,contextHandoff:{version:1,sourceSessionId:row.nativeSessionId,sourceFile:originalArchive,archive:context.archive,summaryFound:context.summaryFound,bytes:context.bytes,records:context.records,preparedAt:new Date().toISOString()}};
  const migration=storage.beginBindingMigration({...row},next);storage.finishBindingMigration(migration);Object.assign(row,next);
}
