import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ProviderUsage} from './providerUsage.js';
export type ClaudeBillingEntry=ProviderUsage&{id:string;threadId:string;userId:string;at:number;model:string;effort:string|null};
const cache=new Map<string,{at:number;entries:ClaudeBillingEntry[]}>(),pending=new Map<string,Promise<ClaudeBillingEntry[]>>();
export function cachedClaudeBilling(directory?:string){return directory?cache.get(directory)?.entries??[]:[];}
/** Shared, bounded worker: parsing native SQLite JSON must not stall streams. */
export function readClaudeBilling(directory?:string):Promise<ClaudeBillingEntry[]>{
  if(!directory)return Promise.resolve([]);
  const saved=cache.get(directory);if(saved&&Date.now()-saved.at<60000)return Promise.resolve(saved.entries);
  const running=pending.get(directory);if(running)return running;
  const work=new Promise<ClaudeBillingEntry[]>((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=256','--import',fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('./claudeBillingWorker.ts',import.meta.url)),path.join(directory,'sessions.sqlite')],{stdio:['ignore','pipe','ignore']});
    let output='',oversized=false;child.stdout.setEncoding('utf8');
    const timer=setTimeout(()=>{child.kill();reject(Error('Claude 用量统计超时，保留上次结果'));},30000);
    child.stdout.on('data',part=>{output+=part;if(Buffer.byteLength(output)>8*1024*1024){oversized=true;child.kill();}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',code=>{clearTimeout(timer);if(code!==0||oversized)return reject(Error('Claude 用量统计未完成，保留上次结果'));
      try{const entries=output.trim()?output.trim().split('\n').map(line=>JSON.parse(line) as ClaudeBillingEntry):[];cache.set(directory,{at:Date.now(),entries});resolve(entries);}catch{reject(Error('Claude 用量统计格式无效'));}
    });
  }).finally(()=>pending.delete(directory));pending.set(directory,work);return work;
}
