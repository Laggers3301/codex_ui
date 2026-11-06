import {DatabaseSync} from 'node:sqlite';
export function queryClaudeHistory(database:string,userId:string,scopes:Array<{threadId:string;maxRowid:number}>,operation:any){
  const db=new DatabaseSync(database,{readOnly:true});
  try{
    for(const s of scopes){const row=db.prepare("SELECT 1 FROM conversations WHERE id=? AND json_extract(body,'$.userId')=?").get(s.threadId,userId);if(!row||!Number.isSafeInteger(s.maxRowid))throw Error('History scope forbidden');}
    const content="CASE WHEN json_type(j.value,'$.content')='array' THEN (SELECT group_concat(COALESCE(json_extract(p.value,'$.text'),''),char(10)) FROM json_each(j.value,'$.content') p) ELSE json_extract(j.value,'$.content') END";
    const expression=`COALESCE(json_extract(j.value,'$.text'),json_extract(j.value,'$.aggregatedOutput'),json_extract(j.value,'$.output'),${content},'')`;
    if(operation.kind==='search'){
      const q=typeof operation.query==='string'?operation.query.trim():'';if(q.length<2||q.length>128)throw Error('Use a keyword of 2–128 characters');
      const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%',results:any[]=[];
      for(const s of [...scopes].reverse()){
        const rows=db.prepare(`SELECT t.id,j.key AS item,length(${expression}) AS length,substr(${expression},max(1,instr(lower(${expression}),lower(?))-180),1000) AS excerpt FROM turns t,json_each(t.body,'$.items') j WHERE t.thread_id=? AND t.rowid<=? AND ${expression} LIKE ? ESCAPE '\\' ORDER BY t.created_at DESC,t.rowid DESC LIMIT ?`).all(q,s.threadId,s.maxRowid,pattern,Math.max(0,8-results.length));
        for(const r of rows)results.push({ref:Buffer.from(JSON.stringify({threadId:s.threadId,id:r.id,item:r.item})).toString('base64url'),length:r.length,excerpt:r.excerpt});
        if(results.length>=8)break;
      }
      return {results,note:'最多8条命中；可换关键词检索。read 返回分段原文，可继续翻页，不表示更早记录已删除。'};
    }
    if(operation.kind==='read'){
      if(typeof operation.ref!=='string'||operation.ref.length>1024)throw Error('Invalid reference');
      const ref=JSON.parse(Buffer.from(operation.ref,'base64url').toString()),s=scopes.find(s=>s.threadId===ref.threadId),offset=operation.offset??0;
      if(!s||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(ref.item)||ref.item<0)throw Error('Reference forbidden');
      const row=db.prepare(`SELECT length(${expression}) AS length,substr(${expression},?,2000) AS text FROM turns t,json_each(t.body,'$.items') j WHERE t.thread_id=? AND t.id=? AND t.rowid<=? AND j.key=?`).get(offset+1,s.threadId,ref.id,s.maxRowid,ref.item);
      if(!row)throw Error('Reference not found within the branch boundary');
      return {ref:operation.ref,offset,text:row.text,length:row.length,nextOffset:offset+2000<Number(row.length)?offset+2000:null};
    }
    throw Error('Unknown history operation');
  }finally{db.close();}
}
if(process.argv[1]?.endsWith('claudeHistoryRecallWorker.ts')){
  process.stdin.setEncoding('utf8');let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>64*1024)throw Error('Invalid request');}
  const input=JSON.parse(raw);process.stdout.write(JSON.stringify(queryClaudeHistory(input.database,input.userId,input.scopes,input.operation)));
}
