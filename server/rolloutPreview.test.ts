import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {rolloutPreviewRecords,previewImageMarkers} from './rolloutPreview.js';
import {historyImageStream} from './historyImage.js';
import {MAX_HISTORY_RECORD_BYTES} from './rolloutStorage.js';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const line=(value:unknown)=>JSON.stringify(value)+'\n';
const tool=(output:unknown)=>({type:'response_item',payload:{type:'custom_tool_call_output',call_id:'call-image',output}});
const collect=async(file:string,range?:{start?:number;end?:number})=>{
  const records=[];for await(const row of rolloutPreviewRecords(file,range))records.push(row);return records;
};

it('streams a >16MiB image, preserves original bytes and offsets, and pages past it',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'image-preview-'));
  vi.stubEnv('CODEX_THREAD_INDEX_DB',path.join(root,'index.sqlite'));
  vi.stubEnv('CODEX_WEB_CODEX_SESSION_ROOTS',root);vi.resetModules();
  try{
    const file=path.join(root,'rollout-thread.jsonl');
    const image=Buffer.alloc(13*1024*1024,123),url='data:image/png;base64,'+image.toString('base64');
    const prefix=line({type:'session_meta',payload:{id:'image-thread'}})+line({type:'turn_context',payload:{turn_id:'turn-one'}})+line({type:'response_item',payload:{type:'custom_tool_call',call_id:'call-image',name:'exec',input:'view_image'}});
    const source=prefix+line(tool([{type:'input_text',text:'原图前的文字'},{type:'input_image',image_url:url},{type:'input_text',text:'原图后的文字'}]))+line({type:'response_item',payload:{type:'message',role:'assistant',id:'after-image',content:[{type:'output_text',text:'图片后的完整回答'}]}});
    const originalHash=sha(source);await fs.writeFile(file,source);const before=await fs.stat(file);
    const rows=await collect(file);expect(rows).toHaveLength(5);
    const preview=JSON.parse(rows[3].text),markers=previewImageMarkers(preview.payload.output);
    expect(rows[3].text.length).toBeLessThan(1000);expect(markers).toHaveLength(1);
    expect(rows[3].start).toBe(Buffer.byteLength(prefix));
    expect(rows[3].end).toBe(rows[4].start);expect(rows[4].end).toBe(Buffer.byteLength(source));
    const [,start,end]=markers[0].split(':');
    const raw=Buffer.from(source);expect(raw.subarray(Number(start),Number(end)).toString()).toBe(url);
    const {stream,mime}=await historyImageStream(file,Number(start),Number(end));const decodedHash=createHash('sha256');
    for await(const part of stream)decodedHash.update(part);
    expect(mime).toBe('image/png');expect(decodedHash.digest('hex')).toBe(sha(image));
    const {readIndexedThreadPage,readIndexedThreadItem}=await import('./threadEventIndex.js');
    let page=await readIndexedThreadPage(file,'image-thread',{limit:1});
    expect(JSON.stringify(page)).toContain('图片后的完整回答');expect(page.history.hasOlder).toBe(true);
    page=await readIndexedThreadPage(file,'image-thread',{limit:1,cursor:page.history.nextCursor!});
    expect(JSON.stringify(page)).toContain(markers[0]);
    expect(JSON.stringify(await readIndexedThreadItem(file,'image-thread','call-image'))).toContain(markers[0]);
    expect(sha(await fs.readFile(file))).toBe(originalHash);const after=await fs.stat(file);
    expect(after.size).toBe(before.size);expect(after.mtimeMs).toBe(before.mtimeMs);
  }finally{vi.unstubAllEnvs();vi.resetModules();await fs.rm(root,{recursive:true,force:true});}
},30000);

it('handles chunk-boundary prefixes, multiple images, UTF-8, CRLF and final records without newline',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'image-boundary-'));
  try{
    const file=path.join(root,'rollout.jsonl');
    for(const padding of [65370,65400,65450,65500,65510,65520,65530]){
      const expectedText='中'.repeat(padding/3)+'x'.repeat(padding%3);
      const record=tool([{type:'input_text',text:expectedText},{type:'input_image',image_url:'data:image/png;base64,YWJj'},{type:'input_image',image_url:{url:'data:image/jpeg;base64,ZGVmZw=='}},{type:'input_text',text:'最后文字'}]);
      await fs.writeFile(file,JSON.stringify(record)+'\r\n'+JSON.stringify({type:'event_msg',payload:{type:'task_complete'}}));
      const rows=await collect(file);expect(rows).toHaveLength(2);const value=JSON.parse(rows[0].text);
      expect(previewImageMarkers(value.payload.output)).toHaveLength(2);expect(value.payload.output[0].text).toBe(expectedText);
      for(const [index,marker] of previewImageMarkers(value.payload.output).entries()){
        const [,start,end]=marker.split(':'),{stream}=await historyImageStream(file,Number(start),Number(end));
        const parts:Buffer[]=[];for await(const part of stream)parts.push(part);expect(Buffer.concat(parts).toString()).toBe(index?'defg':'abc');
      }
      expect(value.payload.output.at(-1).text).toBe('最后文字');
      expect(await collect(file,{start:rows[1].start,end:rows[1].end})).toEqual([rows[1]]);
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

it('does not change user images or quoted source text; still rejects oversized text and corrupt image data',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'image-safety-'));
  try{
    const file=path.join(root,'rollout.jsonl');
    const ordinary=line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,YWJj'}]}})+line(tool('quoted "data:image/png;base64,YWJj" source'));
    await fs.writeFile(file,ordinary);expect((await collect(file)).map(x=>x.text).join('\n')+'\n').toBe(ordinary);
    await fs.writeFile(file,line(tool('x'.repeat(MAX_HISTORY_RECORD_BYTES+1))));await expect(collect(file)).rejects.toMatchObject({code:'HISTORY_MEMORY_LIMIT'});
    await fs.writeFile(file,line(tool([{type:'input_image',image_url:'data:image/png;base64,not!base64'}])));await expect(collect(file)).rejects.toThrow('编码');
    await fs.writeFile(file,line(tool([{type:'input_image',image_url:'data:image/png;base64,YWJj'}])));
    const row=(await collect(file))[0],marker=previewImageMarkers(JSON.parse(row.text).payload.output)[0],[,start,end]=marker.split(':');
    for(const [s,e] of [[0,Number(end)],[Number(start)+1,Number(end)],[Number(start),Number(end)+1],[NaN,Number(end)],[Number(start),Number(end)+200]])await expect(historyImageStream(file,s,e)).rejects.toThrow();
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
