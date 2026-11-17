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

it('with needles, decodes only matching lines and yields nothing extra; without them it yields every line',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'billing-lines-needles-'));
 try{const file=path.join(root,'test.jsonl');
 const a=JSON.stringify({type:'event_msg',payload:{type:'token_count',n:1}}),b=JSON.stringify({type:'response_item',payload:{output:'中文'.repeat(1000)}}),c=JSON.stringify({type:'turn_context',payload:{turn_id:'t'}});
 await fs.writeFile(file,[a,b,c].join('\n'));// no trailing newline: the final line must still be handled
 const all=[];for await(const line of billingLines(file))all.push(line);expect(all).toEqual([a,b,c]);
 const some=[];for await(const line of billingLines(file,['"token_count"','"turn_context"']))some.push(line);expect(some).toEqual([a,c]);
 const none=[];for await(const line of billingLines(file,['"nothing_like_this"']))none.push(line);expect(none).toEqual([]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
