import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {billingLines} from './billingLines.js';
it('skips huge image bytes while preserving subsequent billing counters',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'billing-lines-'));
 try{const file=path.join(root,'test.jsonl');const counter=JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:12}}}});
 await fs.writeFile(file,JSON.stringify({type:'event_msg',payload:{type:'image_generation_end',image:'x'.repeat(3*1024*1024)}})+'\n'+counter+'\n');
 const rows=[];for await(const line of billingLines(file))rows.push(line);expect(rows).toEqual([counter]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
