import {DatabaseSync} from 'node:sqlite';
import {normalizeProviderUsage} from './providerUsage.js';
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try{
  const rows=db.prepare(`SELECT t.id,t.thread_id,t.created_at,
    json_extract(t.body,'$.usage') usage,json_extract(t.body,'$.billingModel') model,json_extract(t.body,'$.billingEffort') effort,
    json_extract(c.body,'$.userId') user_id
    FROM turns t JOIN conversations c ON c.id=t.thread_id WHERE json_type(t.body,'$.usage')='object'`).iterate();
  for(const row of rows){
    const usage=normalizeProviderUsage(JSON.parse(String(row.usage)));
    if(!usage.totalTokens)continue;
    // Only locally executed turns have usage. Imported/forked display history
    // is not billed again; context snapshots are never summed as token usage.
    console.log(JSON.stringify({id:row.id,threadId:row.thread_id,userId:row.user_id,at:Number(row.created_at),
      model:typeof row.model==='string'?row.model:'Claude (legacy)',effort:typeof row.effort==='string'?row.effort:null,...usage}));
  }
}finally{db.close();}
