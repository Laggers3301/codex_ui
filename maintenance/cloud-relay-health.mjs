import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export const relaySshArgs=['-F','/dev/null','-T','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=3',...(process.env.CODEX_RELAY_SSH_KEY ? ['-i',process.env.CODEX_RELAY_SSH_KEY] : []),process.env.CODEX_RELAY_SSH_TARGET ?? ''];
export async function probeCloudRelay() {
  try {
    const config=JSON.parse(await fs.readFile(new URL('../data/backend/cloudflare-cloud-relay.json',import.meta.url),'utf8'));
    if(config.enabled!==true)return null;
  }catch{return null;}
  try {
    const result=await execute('/usr/bin/ssh',[...relaySshArgs,'health'],{timeout:6500,maxBuffer:8192});
    const value=JSON.parse(result.stdout.trim());
    return {ready:value.ready===200?200:503,origin:value.origin===200?200:0};
  }catch{return {ready:0,origin:0};}
}
export async function restartCloudTunnel() {
  const result=await execute('/usr/bin/ssh',[...relaySshArgs,'restart-tunnel'],{timeout:6500,maxBuffer:8192});
  if(JSON.parse(result.stdout.trim()).ok!==true)throw new Error('Cloud relay restart rejected');
}
