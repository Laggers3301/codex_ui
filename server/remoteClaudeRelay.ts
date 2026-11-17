import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { AppError } from './appErrors.js';

/** Private deployment configuration, never accepted from a browser request. */
export interface RemoteClaudeConfig {
  userId: string; sourceThreadId: string; orgId: string; label: string;
  host: string; port: number; sshUser: string; keyFile: string; knownHostsFile: string;
  accountKey: string; deviceId: string; configRoot: string; executable: string;
  models: Array<{key:string;nativeId:string;label:string;supportedEffortLevels:Array<'low'|'medium'|'high'|'xhigh'|'max'>}>;
}

export function remoteSshArgs(config: RemoteClaudeConfig, action: 'probe' | 'relay') {
  if (!/^[a-zA-Z0-9.-]+$/.test(config.host) || !/^[a-z_][a-z0-9_-]*$/.test(config.sshUser)
    || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535
    || !config.keyFile.startsWith('/') || !config.knownHostsFile.startsWith('/')) throw new Error('Invalid private SSH configuration');
  return ['-T','-i',config.keyFile,'-p',String(config.port),'-o','IdentitiesOnly=yes','-o','BatchMode=yes',
    '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${config.knownHostsFile}`,
    '-o','ConnectTimeout=10','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3',
    `${config.sshUser}@${config.host}`,action];
}

export async function probeRemoteClaude(config: RemoteClaudeConfig) {
  const child=spawn('/usr/bin/ssh',remoteSshArgs(config,'probe'),{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.length>32768)child.kill();});
  child.stderr.resume();
  const timer=setTimeout(()=>child.kill(),15000);
  try {
    const [code]=await once(child,'close');
    if(code!==0)throw new Error('SSH probe failed');
    const value=JSON.parse(output);
    if(value.ok!==true || value.userId!==config.userId || value.sourceThreadId!==config.sourceThreadId
      || value.orgId!==config.orgId || value.accountKey!==config.accountKey || value.deviceId!==config.deviceId
      || !value.executablePresent || config.models.some(model=>!value.models?.includes(model.nativeId))) throw new Error('Remote identity mismatch');
    return value as {ok:true;accountKey:string;orgId:string;deviceId:string};
  } catch {throw new AppError('remote_identity_unverified','金山专用连接或设备身份未通过验证；未重新登录或切换其他账号。');}
  finally {clearTimeout(timer);}
}

type RelayEnvelope = {id:string;userId:string;sourceThreadId:string;cursor:number;action?:'cancel';method?:string;path?:string;headers?:Record<string,string>;body?:string};
type RelayEvent = {type:string;seq?:number;status?:number;headers?:Record<string,string>;data?:string};

/** Reattach the SAME remote HTTP request after SSH drops. Never resubmit the
 * upstream model POST: the remote start marker and sequence log own that. */
export async function relayRemoteRequest(config:RemoteClaudeConfig,envelope:RelayEnvelope,onEvent:(event:RelayEvent)=>Promise<void>,signal:AbortSignal,
  launch:typeof spawn=spawn,deadlineMs=180000) {
  let cursor=0,terminal=false,lastContact=Date.now();
  for(let attempt=0;!terminal&&!signal.aborted;attempt++){
    if(Date.now()-lastContact>=deadlineMs)throw new Error('Remote connection recovery timed out');
    const child=launch('/usr/bin/ssh',remoteSshArgs(config,'relay'),{stdio:['pipe','pipe','pipe']});
    const abort=()=>child.kill('SIGTERM');signal.addEventListener('abort',abort,{once:true});
    child.stderr!.resume();child.stdin!.on('error',()=>{});
    child.stdin!.end(JSON.stringify({...envelope,cursor}));
    const reader=createInterface({input:child.stdout!,crlfDelay:Infinity});
    child.on('error',()=>reader.close());
    try {
      for await(const line of reader){
        if(line.length>2*1024*1024)throw new Error('Invalid remote frame');
        const event=JSON.parse(line) as RelayEvent;
        if(event.type==='heartbeat'){lastContact=Date.now();continue;}
        if(!Number.isSafeInteger(event.seq))throw new Error('Invalid remote sequence');
        if(event.seq! <= cursor)continue;
        if(event.seq!==cursor+1)throw new Error('Remote stream sequence gap');
        await onEvent(event);cursor=event.seq!;lastContact=Date.now();
        if(event.type==='end'){terminal=true;break;}
        if(event.type==='error')throw new Error('Remote upstream transport failed; request will not be replayed');
      }
    } finally {reader.close();signal.removeEventListener('abort',abort);child.kill('SIGTERM');}
    if(terminal||signal.aborted)break;
    await new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(finish,Math.min(5000,500*2**Math.min(attempt,4)));signal.addEventListener('abort',finish,{once:true});
    });
  }
}

function authorized(request:IncomingMessage,secret:string){
  const supplied=request.headers['x-api-key']??request.headers.authorization?.replace(/^Bearer /,'');
  if(typeof supplied!=='string')return false;
  const a=Buffer.from(supplied),b=Buffer.from(secret);return a.length===b.length&&timingSafeEqual(a,b);
}

/** Only a bound Claude turn receives the ephemeral loopback credential. It is
 * NOT the KS account/device token. Native filesystem/MCP tools stay local. */
export async function startRemoteClaudeRelay(config:RemoteClaudeConfig,scope:{userId:string;sourceThreadId:string;turnId:string},relay:typeof relayRemoteRequest=relayRemoteRequest){
  if(scope.userId!==config.userId||scope.sourceThreadId!==config.sourceThreadId)throw new AppError('runtime_forbidden','金山账号仅授权指定用户与源会话。');
  const secret=randomBytes(32).toString('hex');const active=new Set<AbortController>();
  const server=createServer(async(request,response)=>{
    if(!authorized(request,secret)){response.writeHead(403).end();return;}
    const path=request.url?.split('?')[0];
    if(!((request.method==='POST'&&['/v1/messages','/v1/messages/count_tokens'].includes(path??''))||(request.method==='GET'&&path==='/v1/models'))){response.writeHead(403).end();return;}
    const buffers:Buffer[]=[];let size=0;
    try {for await(const chunk of request){size+=chunk.length;if(size>16*1024*1024)throw Error('Input too large');buffers.push(Buffer.from(chunk));}}
    catch{response.writeHead(413).end();return;}
    const body=Buffer.concat(buffers);
    if(request.method==='POST'){
      try{if(!config.models.some(model=>model.nativeId===JSON.parse(body.toString()).model))throw Error();}
      catch{response.writeHead(403).end();return;}
    }
    const id=createHash('sha256').update(scope.turnId+'\0'+request.method+'\0'+path+'\0').update(body).digest('hex');
    const headers:Record<string,string>={};for(const key of ['anthropic-version','anthropic-beta','content-type','accept','user-agent','x-app']){
      const value=request.headers[key];if(typeof value==='string')headers[key]=value;
    }
    const envelope:RelayEnvelope={id,userId:scope.userId,sourceThreadId:scope.sourceThreadId,cursor:0,method:request.method,path,headers,body:body.toString('base64')};
    const controller=new AbortController();active.add(controller);let complete=false;
    const disconnect=()=>{if(!complete){controller.abort();const child=spawn('/usr/bin/ssh',remoteSshArgs(config,'relay'),{stdio:['pipe','ignore','ignore']});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({id,userId:scope.userId,sourceThreadId:scope.sourceThreadId,action:'cancel'}));child.on('error',()=>{});const timer=setTimeout(()=>child.kill(),10000);child.on('close',()=>clearTimeout(timer));}};
    response.once('close',disconnect);
    try{
      await relay(config,envelope,async event=>{
        if(controller.signal.aborted)return;
        if(event.type==='headers'){
          if(response.headersSent)throw new Error('Repeated remote headers');
          response.writeHead(event.status??502,event.headers??{});
        }else if(event.type==='chunk'){
          if(!response.headersSent)throw new Error('Missing remote headers');
          if(!response.write(Buffer.from(event.data??'','base64')))await once(response,'drain',{signal:controller.signal});
        }else if(event.type==='end'){complete=true;response.end();}
      },controller.signal);
    }catch{
      disconnect();
      if(!response.headersSent)response.writeHead(502,{'content-type':'application/json'}).end(JSON.stringify({type:'error',error:{type:'remote_transport_error',message:'金山连接恢复失败；已提交请求不会自动重复执行。'}}));
      else response.destroy();
    }finally{active.delete(controller);response.off('close',disconnect);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,secret,
    close:()=>{for(const controller of active)controller.abort();server.closeAllConnections();server.close();}};
}
