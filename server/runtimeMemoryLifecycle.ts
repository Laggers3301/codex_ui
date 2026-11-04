import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from './appErrors.js';
import {rolloutLogicalStat} from './rolloutStorage.js';

/** A single lane shared by every local account, not just each account separately. */
export class RuntimeLoadScheduler {
  private tail:Promise<void>=Promise.resolve();
  async run<T>(load:()=>Promise<T>,maxWaitMs=120000):Promise<T>{
    const previous=this.tail;let release!:()=>void;
    this.tail=new Promise<void>(resolve=>{release=resolve;});
    let granted=false,timer:ReturnType<typeof setTimeout>|undefined;
    const started=Date.now();
    try {
      await Promise.race([previous,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AppError('memory_pressure','大历史加载仍在排队，请稍后重试。')),maxWaitMs);})]);
      granted=true;clearTimeout(timer);
      if(Date.now()-started>=2000)console.info('[runtime.load.queued]',JSON.stringify({waitedMs:Date.now()-started}));
      return await load();
    } finally {clearTimeout(timer);if(granted)release();else void previous.then(release,release);}
  }
}
export const runtimeLoadScheduler=new RuntimeLoadScheduler();

export async function runtimeHistoryBytes(home:string|undefined,params:Record<string,unknown>):Promise<number|null>{
  let file=typeof params.path==='string'?params.path:null;
  if(!file && home && typeof params.threadId==='string'){
    let db:DatabaseSync|undefined;
    try {db=new DatabaseSync(path.join(home,'state_5.sqlite'),{readOnly:true});file=(db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(params.threadId) as {rollout_path?:string}|undefined)?.rollout_path??null;}
    catch {return null;} finally {db?.close();}
  }
  if(!file)return null;
  try{return (await rolloutLogicalStat(file)).size;}catch{return null;}
}
export function hostMemoryAvailable():number {
  try {const match=fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+) kB/m);if(match)return Number(match[1])*1024;}catch{}
  return os.freemem();
}
export function assertRuntimeLoadBudget(size:number|null,host:number,scope:number|null):void {
  const reserve=512*1024*1024;
  const required=size!==null && size>=128*1024*1024?size*3+reserve:reserve;
  if(host<required || scope!==null && scope<required)throw new AppError('memory_pressure',
    '当前内存余量不足以加载此会话，请稍后重试或使用安全精简分支。',
    `需要约 ${Math.ceil(required/1048576)} MiB；主机可用 ${Math.floor(host/1048576)} MiB；运行时余量 ${scope===null?'未知':Math.floor(scope/1048576)+' MiB'}。`);
}

/** Only drops event subscriptions. Native Codex owns the actual idle unload. */
export class IdleThreadReclaimer {
  private timers=new Map<string,ReturnType<typeof setTimeout>>();
  private running=new Map<string,Promise<void>>();
  private generation=0;
  constructor(private reclaim:(id:string)=>Promise<void|boolean>,private idleMs=5*60_000){}
  schedule(id:string):void {
    if(this.timers.has(id)||this.running.has(id))return;
    const generation=this.generation;
    const timer=setTimeout(()=>{
      this.timers.delete(id);
      let retry=false;
      const pending=Promise.resolve().then(()=>generation===this.generation?this.reclaim(id):undefined)
        .then(result=>{retry=result===false;}).catch(()=>undefined).finally(()=>{this.running.delete(id);if(retry&&generation===this.generation)this.schedule(id);});
      this.running.set(id,pending);
    },this.idleMs);
    timer.unref?.();this.timers.set(id,timer);
  }
  async beforeUse(id:string):Promise<void>{clearTimeout(this.timers.get(id));this.timers.delete(id);await this.running.get(id);clearTimeout(this.timers.get(id));this.timers.delete(id);}
  clear():void {this.generation++;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();}
}
