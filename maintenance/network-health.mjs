import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import {restartCloudTunnel} from './cloud-relay-health.mjs';
const execute=promisify(execFile);
const WebSocket=createRequire(new URL('../package.json',import.meta.url))('ws');
export function lanIsDegraded(network) {
  return network?.gateway?.ok===false || (network?.gateway?.ms??0)>100;
}
export function edgeCount(response) {
  const value=response?.status===200?response.text.match(/^cloudflared_tunnel_ha_connections\s+(\d+)/m):null;
  return value?Number(value[1]):null;
}
export function confirmedEdgeCount(metrics,readiness) {
  // ha_connections counts Serve attempts too, not only registered connectors.
  // /ready is the connector's actual registration health; a nonzero attempt
  // gauge must never mask a confirmed disconnected tunnel.
  if(readiness?.status===503)return 0;
  if(readiness?.status===200)return Math.max(1,edgeCount(metrics)??0);
  return null;
}
export class NetworkRecoveryPolicy {
  frontendFailures=0; tunnelFailures=0; lastRecoveryAt=-Infinity;
  evaluate(snapshot,now=Date.now()) {
    const backendHealthy=[200,401].includes(snapshot.backendStatus)&&snapshot.backendWS;
    const frontendHealthy=snapshot.frontendStatus===200&&snapshot.frontendWS;
    this.frontendFailures=backendHealthy&&!frontendHealthy?this.frontendFailures+1:0;
    // A failed diagnostic SSH session is not proof the existing forwarding
    // session is dead. Likewise, restarting cannot repair a congested LAN;
    // it just disconnects healthy browser sessions and leaves remote listeners.
    const lanDegraded=lanIsDegraded(snapshot.network);
    const relayConfirmed=snapshot.cloudRelay&&snapshot.cloudRelay.reachable!==false&&!lanDegraded;
    this.relayFailures=backendHealthy&&frontendHealthy&&relayConfirmed&&snapshot.cloudRelay.origin!==200?(this.relayFailures??0)+1:0;
    this.cloudFailures=backendHealthy&&frontendHealthy&&snapshot.cloudRelay?.origin===200&&snapshot.cloudRelay.ready!==200?(this.cloudFailures??0)+1:0;
    const edges=snapshot.mainConnections;
    this.tunnelFailures=backendHealthy&&frontendHealthy&&edges===0&&!(snapshot.quicConnections>0)?this.tunnelFailures+1:0;
    if(now-this.lastRecoveryAt<600000)return null;
    const kind=this.frontendFailures>=3?'restart-frontend':this.relayFailures>=3?'restart-ssh-relay':this.cloudFailures>=3?'restart-cloud-tunnel':!snapshot.cloudRelay&&this.tunnelFailures>=3?'restart-tunnel':null;
    if(kind){this.lastRecoveryAt=now;return kind;}
    return null;
  }
}
async function cookie() {
  const secret=(await fs.readFile(new URL('../data/auth/session-secret',import.meta.url),'utf8')).trim();
  const p=Buffer.from(JSON.stringify({u:'qa-user',exp:Date.now()+60000})).toString('base64url');
  return `codex_remote_session_4575=${p}.${createHmac('sha256',secret).update(p).digest('base64url')}`;
}
export async function probeWebSocket(url) {
  const started=Date.now();let headers;
  try{headers={Cookie:await cookie()};}catch{return {ok:false,reason:'probe-auth-unavailable'};}
  return new Promise(resolve=>{
    const ws=new WebSocket(url,{headers,handshakeTimeout:2500,maxPayload:2*1024*1024});
    let settled=false;
    const finish=(ok,reason)=>{if(settled)return;settled=true;clearTimeout(timer);ws.terminate();resolve({ok,ms:Date.now()-started,...(reason?{reason}:{})});};
    const timer=setTimeout(()=>finish(false,'timeout'),3000);
    ws.on('error',()=>finish(false,'handshake-error'));
    ws.on('close',()=>finish(false,'closed-before-hello'));
    ws.on('message',raw=>{try{if(JSON.parse(String(raw)).type==='hello')finish(true);}catch{finish(false,'invalid-response');}});
  });
}
export async function networkEvidence() {
  const [gateway,edge]=await Promise.all([
    execute('/usr/bin/ping',['-n','-c','1','-W','1','192.168.50.1'],{timeout:2000}).then(r=>({ok:true,ms:Number(r.stdout.match(/time[=<]([\d.]+)/)?.[1])||null})).catch(()=>({ok:false})),
    new Promise(resolve=>{const start=Date.now();const s=net.connect({host:'region1.v2.argotunnel.com',port:7844});let done=false;const finish=ok=>{if(done)return;done=true;s.destroy();resolve({ok,ms:Date.now()-start});};s.setTimeout(2500,()=>finish(false));s.on('connect',()=>finish(true));s.on('error',()=>finish(false));})
  ]);
  return {gateway,cloudflareTcp7844:edge};
}
export function recoveryFailureReason(kind,error) {
  const detail=String(error?.stderr||error?.message||'');
  if(kind==='restart-tunnel'&&/password is required|not allowed to execute|a terminal is required/i.test(detail))return 'administrator-permission-required';
  if(error?.killed||/timeout|timed out/i.test(detail))return 'restart-timeout';
  return 'restart-failed';
}
export async function recoverNetwork(kind) {
  // Never restart the model backend or host. Tunnel recovery requires a narrowly
  // granted administrator rule; lack of that rule is reported, not bypassed.
  if(kind==='restart-cloud-tunnel'){
    try{await restartCloudTunnel();return {ok:true,kind};}catch{return {ok:false,kind,reason:'cloud-restart-failed'};}
  }
  const command=kind==='restart-frontend'?['/usr/bin/systemctl',['--user','restart','codex-ui-v2.service']]:kind==='restart-ssh-relay'?['/usr/bin/systemctl',['--user','restart','codex-cloudflare-ssh-relay.service']]:kind==='restart-tunnel'?['/usr/bin/sudo',['-n','/usr/bin/systemctl','restart','cloudflared.service']]:null;
  if(!command)return {ok:false,kind,reason:'unsupported-recovery-kind'};
  // A restart includes both graceful stop and the new startup. cloudflared's
  // graceful stop alone can take 30 s; 15 s incorrectly killed our waiter and
  // reported an authorization failure even though systemd accepted the job.
  try{await execute(command[0],command[1],{timeout:60000});return {ok:true,kind};}
  catch(error){return {ok:false,kind,reason:recoveryFailureReason(kind,error)};}
}
