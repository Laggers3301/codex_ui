import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHmac} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

export function renewalEvidence(baseline, native, quota, now=Date.now()) {
  const oldExpiry=Date.parse(baseline.expiresAt),issued=Date.parse(native.issuedAt),expiry=Date.parse(native.expiresAt);
  if(![oldExpiry,issued,expiry,Date.parse(baseline.issuedAt)].every(Number.isFinite))return 'invalid_metadata';
  const advanced=issued>Date.parse(baseline.issuedAt)&&expiry>oldExpiry&&issued<=now+60000;
  if(advanced&&now>oldExpiry&&expiry>now&&quota.status==='ready'&&!quota.stale&&Date.parse(quota.updatedAt)>oldExpiry&&now-Date.parse(quota.updatedAt)<120000)return 'verified';
  return advanced?'dates_advanced_waiting_for_old_expiry':'waiting_for_native_renewal';
}

async function main() {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const option=name=>process.argv[process.argv.indexOf(name)+1];
  const baseline={issuedAt:option('--issued-at'),expiresAt:option('--expires-at')};
  if(!process.argv.includes('--issued-at')||!process.argv.includes('--expires-at')||![baseline.issuedAt,baseline.expiresAt].every(v=>Number.isFinite(Date.parse(v))))throw Error('Explicit baseline dates required');
  const identities=path.join(process.env.ARKCLI_STATE_DIR??path.join(os.homedir(),'.arkcli'),'identities');
  const userId=process.env.QA_USER_ID;
  if(!userId)throw Error('Explicit QA_USER_ID required for authenticated read-only verification');
  const candidates=[];
  for(const name of await fs.readdir(identities)){const p=path.join(identities,name,'token.json');try{await fs.access(p);candidates.push(p)}catch{}}
  if(candidates.length!==1)throw Error('Active native identity is ambiguous; no verification performed');
  const state={baseline,startedAt:new Date().toISOString(),observations:[],result:'running'};
  const output=path.join(root,'data/backend/ark-renewal-verification.json');
  const deadline=Date.parse(baseline.expiresAt)+4*60000;
  let previous='';
  while(Date.now()<deadline){
    // Metadata only. Never decode, copy, compare or output credential values;
    // the production native CLI is the only process performing OAuth renewal.
    const row=JSON.parse(await fs.readFile(candidates[0],'utf8'));
    const native={issuedAt:new Date(Number(row.timestamp_ms)).toISOString(),expiresAt:new Date(Number(row.timestamp_ms)+Number(row.expires_in)*1000).toISOString()};
    let quota={status:'unconfirmed',updatedAt:null,stale:true};
    try{
      const cached=JSON.parse(await fs.readFile(path.join(root,'data/backend/provider-quota-cache.json'),'utf8'));
      quota={status:cached.status,updatedAt:cached.updatedAt,stale:Date.now()-Date.parse(cached.updatedAt)>120000};
    }catch{/* A missing cache is not renewal evidence. */}
    if(Date.now()>Date.parse(baseline.expiresAt))try{
      const secret=(await fs.readFile(path.join(root,'data/auth/session-secret'),'utf8')).trim();
      const payload=Buffer.from(JSON.stringify({u:userId,exp:Date.now()+60000})).toString('base64url');
      const value=payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
      const r=await fetch('http://127.0.0.1:4574/api/codex/provider-quotas',{headers:{Cookie:`codex_remote_session_4575=${value}`},signal:AbortSignal.timeout(5000)});
      if(r.ok){const body=await r.json();const q=body.data?.items?.find(q=>q.id==='ark');if(q)quota={status:q.status,updatedAt:q.updatedAt,stale:q.stale};}
    }catch{quota={status:'unconfirmed',updatedAt:null,stale:true};/* Never change login or restart. */}
    const result=renewalEvidence(baseline,native,quota);
    const key=JSON.stringify({native,status:quota.status,result});
    if(key!==previous||result==='verified'){
      const entry={at:new Date().toISOString(),native,quota,result};state.observations.push(entry);state.observations=state.observations.slice(-48);previous=key;
      if(result==='verified')state.result='verified';
      await fs.writeFile(output,JSON.stringify(state,null,2),{mode:0o600});console.log(JSON.stringify(entry));
    }
    if(result==='verified')return;
    await sleep(20000);
  }
  state.result='not_verified_before_deadline';state.finishedAt=new Date().toISOString();
  await fs.writeFile(output,JSON.stringify(state,null,2),{mode:0o600});throw Error('Native renewal not verified; evidence retained, no credentials changed');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1});
