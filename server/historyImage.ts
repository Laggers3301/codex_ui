import {Transform} from 'node:stream';
import {rolloutReadStream,openReadableRollout} from './rolloutStorage.js';

export async function historyImageStream(file:string,start:number,end:number){
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<=start||end-start>128*1024*1024)throw new Error('图片范围无效。');
  const handle=await openReadableRollout(file);let prefix:string;
  try{
    const stat=await handle.stat();if(end>=stat.size)throw new Error('图片范围已失效。');
    const head=Buffer.alloc(Math.min(96,end-start+1)),quotes=Buffer.alloc(2);
    await handle.read(head,0,head.length,start);await handle.read(quotes,0,1,start-1);await handle.read(quotes,1,1,end);
    const match=/^data:image\/(png|jpeg|webp|gif);base64,/.exec(head.toString('ascii'));
    if(!match||quotes[0]!==34||quotes[1]!==34)throw new Error('原图位置无法确认。');prefix=match[0];
  }finally{await handle.close();}
  if(end<=start+prefix.length)throw new Error('原图内容为空。');
  const input=await rolloutReadStream(file,{start:start+prefix.length,end:end-1},0);let tail='';
  const output=new Transform({transform(chunk:Buffer,_encoding,done){const value=tail+chunk.toString('latin1');if(/[^A-Za-z0-9+/=]/.test(value)){done(new Error('原图编码无效。'));return;}const length=value.length-value.length%4;tail=value.slice(length);done(null,Buffer.from(value.slice(0,length),'base64'));},flush(done){if(tail.length){done(new Error('原图编码不完整。'));return;}done();}});
  input.once('error',(error:Error)=>output.destroy(error));output.once('close',()=>input.destroy());input.pipe(output);
  return {stream:output,mime:prefix.slice(5,prefix.indexOf(';'))};
}
