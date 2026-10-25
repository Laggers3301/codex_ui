import fs from 'node:fs/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createZstdDecompress} from 'node:zlib';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import os from 'node:os';

// A bounded, private read cache, NOT another history store. Canonical paths and
// native .jsonl.zst files remain untouched; native resume owns writable recovery.
const defaultCache = path.join(os.tmpdir(), `codex-web-rollout-read-${process.getuid?.() ?? 'user'}`);
const pending = new Map<string, Promise<string>>();
const readers = new Map<string,number>();
function pin(file:string) {readers.set(file,(readers.get(file)??0)+1);return ()=>{const n=(readers.get(file)??1)-1;n?readers.set(file,n):readers.delete(file);};}
let queue: Promise<unknown> = Promise.resolve();
const maxFileBytes = 2 * 1024 ** 3;
const maxCacheBytes = 4 * 1024 ** 3;
export const MAX_FULL_HISTORY_BYTES = 8 * 1024 * 1024;
export const MAX_HISTORY_RECORD_BYTES = 16 * 1024 * 1024;
export class HistoryMemoryLimitError extends Error {
  readonly statusCode = 413;
  readonly code = 'HISTORY_MEMORY_LIMIT';
  constructor(message = '历史超过安全内存读取上限，请分页查看或下载完整原始记录；原文未修改。') { super(message); }
}

// One JSONL record at a time, with a bound checked before decoding/parsing.
// Never silently skip an oversized record and pretend search was complete.
export async function* rolloutLines(filePath: string) {
  const input = await rolloutReadStream(filePath, {}, 0);
  let chunks: Buffer[] = [], bytes = 0;
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < buffer.length) {
        const newline = buffer.indexOf(10, start);
        const end = newline < 0 ? buffer.length : newline;
        bytes += end - start;
        if (bytes > MAX_HISTORY_RECORD_BYTES) throw new HistoryMemoryLimitError('单条历史超过安全解析上限，已停止本次读取；完整原文仍可下载。');
        chunks.push(buffer.subarray(start, end));
        if (newline < 0) break;
        yield Buffer.concat(chunks, bytes).toString('utf8').replace(/\r$/, '');
        chunks = []; bytes = 0; start = newline + 1;
      }
    }
    if (bytes) yield Buffer.concat(chunks, bytes).toString('utf8').replace(/\r$/, '');
  } finally { input.destroy(); }
}

export async function rolloutSourcePath(filePath: string): Promise<string> {
  try { return await fs.realpath(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !filePath.endsWith('.jsonl')) throw error;
    const zipped = await fs.lstat(filePath + '.zst');
    if (!zipped.isFile() || zipped.isSymbolicLink()) throw new Error('Compressed rollout must be a regular file.');
    return fs.realpath(filePath + '.zst');
  }
}

export async function readableRolloutPath(filePath: string, cacheRoot = defaultCache): Promise<string> {
  try { await fs.stat(filePath); return filePath; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !filePath.endsWith('.jsonl')) throw error; }
  const source = await rolloutSourcePath(filePath);
  const stat = await fs.stat(source);
  const key = createHash('sha256').update(`${source}:${stat.ino}:${stat.size}:${stat.mtimeMs}`).digest('hex');
  const directory = path.resolve(cacheRoot), output = path.join(directory, key + '.jsonl');
  const cached=await fs.stat(output).catch(()=>null);
  if(cached) {await fs.utimes(output,Date.now()/1000,cached.mtimeMs/1000);return output;}
  const existing = pending.get(output); if (existing) return existing;
  const job = queue.then(async () => {
    if (await fs.stat(output).catch(() => null)) return output;
    await fs.mkdir(directory, {recursive:true, mode:0o700});
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (process.getuid && directoryStat.uid !== process.getuid())) throw new Error('Unsafe rollout cache directory.');
    await fs.chmod(directory, 0o700);
    // Only our own disposable cache entries, never sessions or compressed files.
    let used = 0;
    const entries:Array<{file:string,size:number,atime:number}>=[];
    for (const name of await fs.readdir(directory)) {
      if (!/^[a-f0-9]{64}\.jsonl$/.test(name)) continue;
      const candidate = path.join(directory, name), value = await fs.stat(candidate);
      if (Date.now() - value.atimeMs > 3600_000 && !pending.has(candidate) && !readers.has(candidate)) await fs.unlink(candidate);
      else {used += value.size;entries.push({file:candidate,size:value.size,atime:value.atimeMs});}
    }
    for(const entry of entries.sort((a,b)=>a.atime-b.atime)) {
      if(used<=maxCacheBytes-maxFileBytes) break;
      if(readers.has(entry.file)||pending.has(entry.file)) continue;
      await fs.unlink(entry.file);used-=entry.size;
    }
    const space = await fs.statfs(directory);
    const limit = Math.min(maxFileBytes, maxCacheBytes-used, Number(space.bavail)*Number(space.bsize)-512*1024**2);
    if (limit <= 0) throw new Error('会话只读缓存空间不足；压缩原件未修改。');
    const temporary = output + '.' + randomUUID() + '.tmp'; let bytes = 0;
    const bound = new Transform({transform(chunk:Buffer,_encoding,callback) {
      bytes += chunk.length;
      callback(bytes > limit ? new Error('会话只读解压超过缓存上限；压缩原件未修改。') : null, chunk);
    }});
    try {
      await pipeline(createReadStream(source),createZstdDecompress(),bound,createWriteStream(temporary,{flags:'wx',mode:0o600}));
      const after = await fs.stat(source);
      if (after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || after.ino!==stat.ino) throw new Error('压缩历史在读取中发生变化，请重试。');
      await fs.rename(temporary,output);
      await fs.utimes(output,Date.now()/1000,stat.mtimeMs/1000);
      return output;
    } finally { await fs.unlink(temporary).catch(()=>undefined); }
  });
  pending.set(output,job); queue=job.catch(()=>undefined);
  try { return await job; } finally { pending.delete(output); }
}

export async function rolloutStat(filePath:string) { return fs.stat(await readableRolloutPath(filePath)); }

export async function openReadableRollout(filePath:string) {
  const file=await readableRolloutPath(filePath),release=pin(file);
  try {
    const handle=await fs.open(file,'r'),close=handle.close.bind(handle);let closed=false;
    handle.close=async()=>{try{await close();}finally{if(!closed){closed=true;release();}}};
    return handle;
  } catch(error) {release();throw error;}
}

export async function rolloutReadStream(filePath:string,options:Parameters<typeof createReadStream>[1]={},maxRecordBytes=MAX_HISTORY_RECORD_BYTES) {
  const file=await readableRolloutPath(filePath),release=pin(file);
  if(!maxRecordBytes){const stream=createReadStream(file,options);stream.once('close',release);return stream;}
  // Check bytes while still buffered as small chunks. Applies to index scans
  // too, before their pending buffer can grow to an unbounded single line.
  const input=createReadStream(file,{...(typeof options==='object'?options:{}),encoding:undefined});
  let lineBytes=0;
  const bound=new Transform({transform(chunk:Buffer,_encoding,callback){
    let start=0;
    while(start<chunk.length){
      const newline=chunk.indexOf(10,start),end=newline<0?chunk.length:newline;
      lineBytes+=end-start;
      if(lineBytes>maxRecordBytes){callback(new HistoryMemoryLimitError('单条历史超过安全解析上限；原文未修改。'));return;}
      if(newline<0)break;
      lineBytes=0;start=newline+1;
    }
    callback(null,chunk);
  }});
  if(typeof options==='object'&&options?.encoding)bound.setEncoding(options.encoding);
  input.once('close',release);
  input.once('error',error=>bound.destroy(error));
  bound.once('close',()=>input.destroy());
  input.pipe(bound);
  return bound;
}

export async function readRolloutText(filePath:string) {
  const file=await openReadableRollout(filePath);
  try{
    if((await file.stat()).size>MAX_FULL_HISTORY_BYTES)throw new HistoryMemoryLimitError();
    // Fixed buffer also bounds a file that is growing after the stat check.
    const buffer=Buffer.allocUnsafe(MAX_FULL_HISTORY_BYTES+1);
    let used=0;
    while(used<buffer.length){const {bytesRead}=await file.read(buffer,used,buffer.length-used,used);if(!bytesRead)break;used+=bytesRead;}
    if(used>MAX_FULL_HISTORY_BYTES)throw new HistoryMemoryLimitError();
    return buffer.subarray(0,used).toString('utf8');
  }finally{await file.close();}
}

/** Preserve the uncompressed size/mtime used by billing caches, without
 * decompressing every cold conversation just to check whether it changed. */
export async function rolloutLogicalStat(filePath:string) {
  try { return await fs.stat(filePath); }
  catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  const source=await rolloutSourcePath(filePath), handle=await fs.open(source,'r');
  try {
    const stat=await handle.stat(), header=Buffer.alloc(32);
    const {bytesRead}=await handle.read(header,0,header.length,0);
    if(bytesRead<6||header.readUInt32LE(0)!==0xfd2fb528) return rolloutStat(filePath);
    const descriptor=header[4], single=Boolean(descriptor&32), flag=descriptor>>>6;
    let offset=5+(single?0:1)+[0,1,2,4][descriptor&3];
    const sizeBytes=flag===0?(single?1:0):[0,2,4,8][flag];
    if(!sizeBytes||offset+sizeBytes>bytesRead) return rolloutStat(filePath);
    const length=sizeBytes===8?Number(header.readBigUInt64LE(offset)):header.readUIntLE(offset,sizeBytes)+(flag===1?256:0);
    if(!Number.isSafeInteger(length)) throw new Error('Invalid compressed rollout length.');
    stat.size=length; return stat;
  } finally { await handle.close(); }
}
