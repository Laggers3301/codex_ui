// Local client only. The backend owns staging, installation and verification.
// No direct CLI-login fallback, credential write or logout is allowed here.
import net from 'node:net';
import path from 'node:path';
import {appRoot} from '../scripts/runtime-update-state.mjs';
const id=process.argv[2];
const socketPath=path.join(process.env.CODEX_WEB_DATA_DIR??path.join(appRoot,'data/backend'),'auth-control.sock');
function request(input){return new Promise((resolve,reject)=>{
 const socket=net.connect(socketPath);let buffer='';
 const fail=()=>{socket.destroy();reject(new Error('Unified authorization endpoint unavailable; credentials unchanged.'));};
 socket.setTimeout(35000,fail);socket.once('error',fail);
 socket.once('connect',()=>socket.write(JSON.stringify(input)+'\n'));
 socket.on('data',chunk=>{buffer+=chunk.toString('utf8');if(buffer.length>8192)return fail();if(!buffer.includes('\n'))return;
  try{const result=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));socket.destroy();result.ok?resolve(result.data):reject(new Error('Unified authorization request failed; credentials unchanged.'));}catch{fail();}
 });
});}
try{
 if(id==='--check'){console.log(JSON.stringify(await request({action:'health'})));}
 else if(id==='--status'){
  const sessionId=process.argv[3];
  if(!/^[a-f0-9-]{36}$/.test(sessionId??''))throw new Error('Usage: node device-authorize-account.mjs --status <session-id>');
  console.log(JSON.stringify(await request({action:'status',sessionId})));
 }
 else {
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id??''))throw new Error('Usage: node device-authorize-account.mjs <account-id>');
  const status=await request({action:'start',accountId:id});
  console.log(JSON.stringify(status));
  if(status.userCode)console.log(`Open ${status.verificationUrl} and enter ${status.userCode}. Previous credentials remain active until safe handover.`);
  if(status.status==='failed')throw new Error(`Authorization ended: ${status.error??'authorization_failed'}. No logout performed.`);
  // The backend owns the whole lifecycle. Never leave an observer attached to
  // this account's terminal: installation waits for background terminals to end.
  console.log('Backend manages safe handover; this observer exits now. Use --status <session-id> for a single read-only check.');
 }
}catch(error){console.error(error.message);process.exitCode=1;}
