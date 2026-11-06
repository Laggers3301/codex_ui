import {rolloutReadStream,HistoryMemoryLimitError,MAX_HISTORY_RECORD_BYTES} from './rolloutStorage.js';

/** A display-only JSONL reader. Image data is never buffered; offsets always
 * refer to the untouched original bytes, including compressed rollouts. */
export async function* rolloutPreviewRecords(file:string,range:{start?:number;end?:number}={}){
  const input=await rolloutReadStream(file,{start:range.start??0,...(range.end!==undefined?{end:range.end-1}:{})},0);
  let offset=range.start??0,lineStart=offset,rawBytes=0,kept=0,parts:Buffer[]=[],carry=Buffer.alloc(0),head=Buffer.alloc(0);
  let image:{start:number;mime:string}|null=null;
  const append=(b:Buffer)=>{kept+=b.length;if(kept>MAX_HISTORY_RECORD_BYTES)throw new HistoryMemoryLimitError('单条历史的文字内容超过安全解析上限；原文未修改。');if(b.length)parts.push(b);};
  const consume=(part:Buffer,final:boolean)=>{
    if(head.length<4096)head=Buffer.concat([head,part.subarray(0,4096-head.length)]);
    let absolute=lineStart+rawBytes-carry.length;
    let pending=Buffer.concat([carry,part]);carry=Buffer.alloc(0);rawBytes+=part.length;
    for(;;){
      if(image){
        const quote=pending.indexOf(34),end=quote<0?pending.length:quote;
        if(/[^A-Za-z0-9+/=]/.test(pending.subarray(0,end).toString('latin1')))throw new HistoryMemoryLimitError('历史图片编码无法安全预览；原图未修改。');
        if(quote<0){if(final)throw new Error('Incomplete historical image');return;}
        append(Buffer.from(JSON.stringify(`__codex_history_image__:${image.start}:${absolute+quote}:${image.mime}`)));
        image=null;absolute+=quote+1;pending=pending.subarray(quote+1);continue;
      }
      const eligible=/"type"\s*:\s*"response_item"/.test(head.toString('utf8'))&&/"payload"\s*:\s*\{\s*"type"\s*:\s*"(?:custom_tool_call_output|function_call_output|computer_call_output)"/.test(head.toString('utf8'));
      const match=eligible?/(?<!\\)"data:image\/(png|jpeg|webp|gif);base64,/.exec(pending.toString('latin1')):null;
      if(match){append(pending.subarray(0,match.index));image={start:absolute+match.index+1,mime:match[1]};absolute+=match.index+match[0].length;pending=pending.subarray(match.index+match[0].length);continue;}
      const keep=final?0:Math.min(128,pending.length);
      append(pending.subarray(0,pending.length-keep));carry=pending.subarray(pending.length-keep);return;
    }
  };
  try{
    for await(const chunk of input){let start=0;while(start<chunk.length){const at=chunk.indexOf(10,start),end=at<0?chunk.length:at;consume(chunk.subarray(start,end),at>=0);offset+=end-start;if(at<0)break;offset++;yield{text:Buffer.concat(parts,kept).toString('utf8').replace(/\r$/,''),start:lineStart,end:offset};lineStart=offset;rawBytes=0;kept=0;parts=[];head=Buffer.alloc(0);carry=Buffer.alloc(0);image=null;start=at+1;}}
    if(rawBytes){consume(Buffer.alloc(0),true);yield{text:Buffer.concat(parts,kept).toString('utf8'),start:lineStart,end:offset};}
  }finally{input.destroy();}
}

export function previewImageMarkers(value:unknown):string[]{
  if(!Array.isArray(value))return [];
  return value.flatMap(p=>{const url=p?.image_url?.url??p?.image_url??p?.url;return typeof url==='string'&&/^__codex_history_image__:\d+:\d+:(png|jpeg|webp|gif)$/.test(url)?[url]:[];});
}
