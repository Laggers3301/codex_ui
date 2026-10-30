import {createReadStream} from 'node:fs';
import {createZstdDecompress} from 'node:zlib';
import {rolloutSourcePath} from './rolloutStorage.js';

/** Read billing telemetry without materializing compressed conversation history. */
export async function* billingLines(file:string){
  const source=await rolloutSourcePath(file),input=createReadStream(source);
  const stream=source.endsWith('.zst')?input.pipe(createZstdDecompress()):input;
  if(stream!==input)input.on('error',error=>stream.destroy(error));
  let chunks:Buffer[]=[],bytes=0,oversized=false;
  try{for await(const chunk of stream){const b=Buffer.from(chunk);let start=0;
    while(start<b.length){const nl=b.indexOf(10,start),end=nl<0?b.length:nl;
      bytes+=end-start;
      if(bytes<=2*1024*1024)chunks.push(b.subarray(start,end));
      else if(!oversized){const prefix=Buffer.concat(chunks).subarray(0,4096).toString();const types=[...prefix.matchAll(/"type"\s*:\s*"([^"]+)"/g)].map(m=>m[1]);const irrelevant=types[0]==='response_item'||types[0]==='compacted'||(types[0]==='event_msg'&&!!types[1]&&!['token_count','task_started'].includes(types[1]));if(!irrelevant)throw Error('Oversized billing metadata; statistics incomplete');chunks=[];oversized=true;}
      if(nl<0)break;
      if(!oversized)yield Buffer.concat(chunks).toString('utf8');
      chunks=[];bytes=0;oversized=false;start=nl+1;
    }
  }if(bytes&&!oversized)yield Buffer.concat(chunks).toString('utf8');}
  finally{stream.destroy();input.destroy();}
}
