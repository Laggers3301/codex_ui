import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {createHash} from "node:crypto";
import {createGzip} from "node:zlib";
import {pipeline} from "node:stream/promises";
import {once} from "node:events";

export const toolArchiveThreshold = 128 * 1024;
const previewBudget = 32 * 1024;
export interface ToolArchiveSummary { version: 1; threadId: string; sourceThreadId: string; keptRecentTurnIds: string[]; archivedRecords: number; archivedBytes: number; originalBranchBytes: number; branchBytes: number; archiveBytes: number; createdAt: string }
export function toolArchiveRoot(dataDir:string,userId:string):string {return path.join(dataDir,"branch-tool-archives",createHash("sha256").update(userId).digest("hex"));}
export function toolArchivePath(root:string,threadId:string):string {
  if(!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(threadId))throw new Error("Invalid archive thread id");
  return path.join(root,`${threadId}.jsonl.gz`);
}
function headTail(text:string,budget:number):string {
  const bytes=Buffer.from(text);
  if(bytes.length<=budget)return text;
  const half=Math.max(64,Math.floor(budget/2));
  const head=bytes.subarray(0,half).toString("utf8").replace(/\uFFFD$/u,"");
  const tail=bytes.subarray(bytes.length-half).toString("utf8").replace(/^\uFFFD+/u,"");
  return `${head}\n\n[…中间 ${Math.max(0,bytes.length-2*half)} 字节已归档…]\n\n${tail}`;
}
/** Keep the exact result shape, call ids and opaque passthrough metadata. */
export function archivedOutputPreview(row:Record<string,any>,archivePath:string):Record<string,any>|null {
  const p=row.payload;
  if(row.type!=="response_item"||!p||!["custom_tool_call_output","function_call_output"].includes(p.type))return null;
  const serialized=JSON.stringify(p.output);
  if(typeof serialized!=="string"||Buffer.byteLength(serialized)<=toolArchiveThreshold)return null;
  const notice=`[较早的超长工具结果已精简；完整结果在 ${archivePath}，按 call_id=${String(p.call_id??p.id??"未知")} 查询。]`;
  let output:unknown;
  if(typeof p.output==="string")output=`${notice}\n${headTail(p.output,previewBudget)}`;
  else if(Array.isArray(p.output)){
    const textCount=p.output.filter((b:any)=>b?.type==="input_text"&&typeof b.text==="string").length;
    const perText=Math.max(128,Math.floor(previewBudget/Math.max(1,textCount)));
    output=p.output.map((b:any)=>{
      if(b?.type==="input_text"&&typeof b.text==="string")return {...b,text:headTail(b.text,perText)};
      if(b?.type==="input_image"&&Buffer.byteLength(JSON.stringify(b))>toolArchiveThreshold)return {type:"input_text",text:"[较早的大尺寸工具图片已移入完整工具结果附件。]"};
      // Never alter encrypted_content, unknown block kinds, or small image refs.
      return b;
    });
    (output as unknown[]).unshift({type:"input_text",text:notice});
  }else return null;
  if(Buffer.byteLength(JSON.stringify(output))>=Buffer.byteLength(serialized))return null;
  return {...row,payload:{...p,output}};
}
export async function createToolOutputArchive(root:string,summary:ToolArchiveSummary) {
  await fsp.mkdir(root,{recursive:true,mode:0o700});
  const final=toolArchivePath(root,summary.threadId),partial=`${final}.partial`,metadata=`${final}.json`;
  const gzip=createGzip({level:1}),output=fs.createWriteStream(partial,{flags:"wx",mode:0o600});
  const complete=pipeline(gzip,output);void complete.catch(()=>{});
  const write=async(bytes:Buffer|string)=>{if(!gzip.write(bytes))await once(gzip,"drain");};
  await write(`${JSON.stringify({type:"archive_meta",payload:{version:summary.version,threadId:summary.threadId,sourceThreadId:summary.sourceThreadId,keptRecentTurnIds:summary.keptRecentTurnIds,createdAt:summary.createdAt,thresholdBytes:toolArchiveThreshold}})}\n`);
  return {
    path:final,
    async append(bytes:Buffer,start:number){
      await write(`${JSON.stringify({type:"archive_index",sourceByteOffset:start})}\n`);
      await write(bytes);
      summary.archivedRecords++;summary.archivedBytes+=bytes.length;
    },
    async finish(branchBytes:number){
      gzip.end();await complete;
      const handle=await fsp.open(partial,"r+");try{await handle.sync();}finally{await handle.close();}
      await fsp.rename(partial,final);
      summary.archiveBytes=(await fsp.stat(final)).size;
      summary.branchBytes=branchBytes;
      await fsp.writeFile(metadata,JSON.stringify(summary),{mode:0o600,flag:"wx"});
      return summary;
    },
    async abort(){gzip.destroy();output.destroy();await complete.catch(()=>{});await Promise.all([partial,final,metadata].map(f=>fsp.unlink(f).catch(()=>{})));}
  };
}
export async function readToolArchiveSummary(root:string,threadId:string):Promise<ToolArchiveSummary|null> {
  const file=toolArchivePath(root,threadId);
  try{
    const [stat,metaStat]=await Promise.all([fsp.lstat(file),fsp.lstat(`${file}.json`)]);
    if(!stat.isFile()||!metaStat.isFile()||metaStat.size>16384)throw new Error("Invalid archive file");
    const data=JSON.parse(await fsp.readFile(`${file}.json`,"utf8")) as ToolArchiveSummary;
    if(data.threadId!==threadId||data.version!==1)throw new Error("Invalid archive metadata");
    return data;
  }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
}
