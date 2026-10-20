// Offline diagnostic: synthetic history only; no auth, model call or live account.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { CodexBridge } from '../server/codexBridge.js';
const binary = process.argv[2] ?? process.env.CODEX_ROLLBACK_TEST_BIN;
if (!binary) throw new Error('Pass a compatible Codex CLI binary path; this diagnostic never uses a production account.');
for (const enabled of [false, true]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-storage-probe-'));
  const runtime = new CodexBridge({command:binary,args:['app-server','--listen','stdio://','-c',`features.local_thread_store_compression=${enabled}`],env:{PATH:process.env.PATH,CODEX_HOME:root}});
  try {
    const id='443f9dfc-2692-4920-953e-b04cb2dc6c26', timestamp='2026-09-27T14:00:00.000Z';
    const day=path.join(root,'sessions','2026','09','27'); await fs.mkdir(day,{recursive:true});
    const file=path.join(day,`rollout-2026-09-27T22-00-00-${id}.jsonl`);
    const records=[
      {timestamp,type:'session_meta',payload:{id,session_id:id,timestamp,cwd:root,originator:'codex_web_console',cli_version:'0.156.0',source:'appServer',model_provider:'openai',history_mode:'legacy'}},
      {timestamp,type:'event_msg',payload:{type:'task_started',turn_id:'00000000-0000-4000-8000-000000000001'}},
      {timestamp,type:'response_item',payload:{type:'function_call_output',call_id:'synthetic',output:'synthetic repeat '.repeat(250000)}},
      {timestamp,type:'event_msg',payload:{type:'task_complete',turn_id:'00000000-0000-4000-8000-000000000001'}}
    ];
    await fs.writeFile(file,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
    await fs.utimes(file,new Date(timestamp),new Date(timestamp));
    const before=(await fs.stat(file)).size;
    const originalHash=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    await runtime.request('rollout/compress',undefined,20000);
    for(let n=0;n<50;n++) {
      if(await fs.stat(file+'.zst').catch(()=>null)) break;
      await new Promise(r=>setTimeout(r,100));
    }
    const compressed=await fs.stat(file+'.zst').catch(()=>null);
    let lossless: boolean|null=null;
    if(compressed) {
      const decoded=zlib.zstdDecompressSync(await fs.readFile(file+'.zst'));
      lossless=crypto.createHash('sha256').update(decoded).digest('hex')===originalHash;
    }
    const read=await runtime.request('thread/read',{threadId:id,includeTurns:false},20000) as {thread:{path?:string}};
    const plainAfterRead=Boolean(await fs.stat(file).catch(()=>null));
    await runtime.request('thread/resume',{threadId:id,cwd:root,excludeTurns:true},20000);
    const created=await runtime.request('thread/start',{cwd:root,ephemeral:false},20000) as {thread:{historyMode?:string}};
    await runtime.stopAndWait();
    const after=(await fs.stat(file)).size;
    if(enabled&&(!compressed||lossless!==true||after<before)) throw new Error('Lossless compression/resume compatibility failed.');
    console.log(JSON.stringify({enabled,legacyBytesBefore:before,compressedBytes:compressed?.size??null,lossless,readPathExtension:read.thread.path?.endsWith('.zst')?'zst':'jsonl',plainAfterRead,legacyBytesAfterResume:after,newHistoryMode:created.thread.historyMode,productionAccountsTouched:0,modelCalls:0}));
  } finally { await runtime.stopAndWait(); await fs.rm(root,{recursive:true,force:true}); }
}
