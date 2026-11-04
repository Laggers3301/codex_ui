import {openReadableRollout} from './rolloutStorage.js';
import type {SubagentThreadRecord} from './subagentHistory.js';

/** Scan bounded chunks, retaining only a timestamp prefix even for huge tool records. */
export async function historyOffsetAt(filePath:string,cutoff:number,maxEndOffset=Number.MAX_SAFE_INTEGER):Promise<number> {
  const file=await openReadableRollout(filePath);
  try {
    const end=Math.min((await file.stat()).size,maxEndOffset),chunk=Buffer.alloc(256*1024);
    let offset=0,lastEnd=0,prefix='',dated=false;
    while(offset<end){
      const {bytesRead}=await file.read(chunk,0,Math.min(chunk.length,end-offset),offset);if(!bytesRead)break;
      let start=0;
      for(let i=0;i<bytesRead;i++)if(chunk[i]===10){
        if(prefix.length<4096)prefix+=chunk.subarray(start,Math.min(i,start+4096-prefix.length)).toString('utf8');
        const match=prefix.match(/"timestamp"\s*:\s*"([^"\r\n]+)"/),time=match?Date.parse(match[1]):NaN;
        if(Number.isFinite(time)){if(time>cutoff)return lastEnd;dated=true;}
        else if(dated)return lastEnd;
        lastEnd=offset+i+1;prefix='';start=i+1;
      }
      if(prefix.length<4096)prefix+=chunk.subarray(start,Math.min(bytesRead,start+4096-prefix.length)).toString('utf8');
      offset+=bytesRead;
    }
    return lastEnd;
  } finally {await file.close();}
}

export async function freezeInheritedSubagents(records:SubagentThreadRecord[],sourceThreadId:string,cutoff:number,resolve:(row:SubagentThreadRecord)=>Promise<string|null>):Promise<SubagentThreadRecord[]> {
  const result:SubagentThreadRecord[]=[];
  for(const record of records){
    const created=Date.parse(record.createdAt??'');
    if(!Number.isFinite(created)||created>cutoff)continue;
    const file=await resolve(record);if(!file)continue;
    const maxEndOffset=await historyOffsetAt(file,cutoff,record.maxEndOffset);
    if(!maxEndOffset)continue;
    result.push({...record,inherited:true,inheritedFromThreadId:record.inheritedFromThreadId??sourceThreadId,maxEndOffset,updatedAt:new Date(cutoff).toISOString()});
  }
  return result;
}
