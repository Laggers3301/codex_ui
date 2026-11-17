import {rolloutReadStream} from './rolloutStorage.js';
/** Read top-level string metadata without buffering tool payloads. Nested or
 * escaped timestamps in tool results must never decide a branch boundary. */
export async function* jsonlMetadata(file:string,maxEnd=Number.MAX_SAFE_INTEGER){
  const stream=await rolloutReadStream(file,{},0);
  let offset=0,start=0,depth=0,inString=false,escaped=false,expectKey=false,key='',mode:'key'|'value'|null=null,text='',overflow=false;
  let meta:Record<string,string>={};const wanted=new Set(['uuid','timestamp','type','sessionId','agentId']);
  try{for await(const chunk of stream){for(const byte of chunk){
    if(offset>=maxEnd)return;
    offset++;
    if(byte===10&&!inString){if(offset>start)yield {meta,start,end:offset};start=offset;meta={};depth=0;expectKey=false;key='';continue;}
    if(inString){
      if(byte===34&&!escaped){
        if(mode&&!overflow){let value='';try{value=JSON.parse('"'+text+'"');}catch{}if(mode==='key'){key=value;expectKey=false;}else meta[key]=value;}
        inString=false;mode=null;text='';overflow=false;escaped=false;continue;
      }
      if(mode){if(text.length<4096)text+=String.fromCharCode(byte);else overflow=true;}
      escaped=byte===92&&!escaped;continue;
    }
    if(byte===34){inString=true;escaped=false;text='';overflow=false;mode=depth===1?(expectKey?'key':wanted.has(key)?'value':null):null;continue;}
    if(byte===123||byte===91){depth++;if(depth===1)expectKey=true;}
    else if(byte===125||byte===93)depth--;
    else if(byte===44&&depth===1){expectKey=true;key='';}
  }}if(offset>start&&!inString&&depth===0)yield {meta,start,end:offset};}finally{stream.destroy();}
}
