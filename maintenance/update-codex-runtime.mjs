import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appRoot,candidateFile,stableVersion,newerVersion,runtimeBinary,writeState} from '../scripts/runtime-update-state.mjs';
const run=promisify(execFile);
const npm=path.join(path.dirname(process.execPath),'npm');
const reportFile=path.join(appRoot,'bin/runtime-update-status.json');
function report(event,extra={}) {
  const state={at:new Date().toISOString(),event,...extra};
  console.log(JSON.stringify(state));writeState(reportFile,state);
}
async function main() {
  // Dist-tags is a small document; npm view downloads the entire historical
  // package manifest, which is slow and prone to connection resets on proxies.
  const response=await run('/usr/bin/curl',['--fail','--silent','--show-error','--retry','2','--retry-all-errors','--max-time','20','https://registry.npmjs.org/-/package/@openai%2fcodex/dist-tags'],{timeout:70000,maxBuffer:65536});
  const version=JSON.parse(response.stdout).latest;
  if(!stableVersion(version))throw new Error('Registry latest is not a stable release');
  let previous;
  try{previous=JSON.parse(fs.readFileSync(candidateFile,'utf8'));}catch{}
  if(previous?.validated===true&&!newerVersion(version,previous.version)){report('already_validated',{version});return;}
  const disk=fs.statfsSync(appRoot);
  if(disk.bavail*disk.bsize<8*1024**3){report('deferred_low_disk',{version});return;}
  const root=path.join(appRoot,`bin/codex-${version}`);
  const binary=runtimeBinary(version);
  // Immutable version directories. Never replace an executable in use.
  try{const existing=await run(binary,['--version'],{timeout:5000,maxBuffer:65536});if(!existing.stdout.includes(` ${version}`))throw new Error('wrong binary');}
  catch {
    report('installing',{version});
    await run(npm,['install','--prefix',root,'--no-save','--no-package-lock','--ignore-scripts','--no-audit','--registry=https://registry.npmjs.org',`@openai/codex@${version}`],{timeout:900000,maxBuffer:262144});
  }
  const identity=await run(binary,['--version'],{timeout:5000,maxBuffer:65536});
  if(identity.stdout.trim()!==`codex-cli ${version}`)throw new Error('Installed version does not match registry');
  const schema=fs.mkdtempSync(path.join(os.tmpdir(),'codex-update-schema-'));
  await run(binary,['app-server','generate-ts','--experimental','--out',schema],{timeout:30000,maxBuffer:65536});
  const protocol=fs.readFileSync(path.join(schema,'ClientRequest.ts'),'utf8');
  const methods=new Set([...protocol.matchAll(/"method":\s*"([^\"]+)"/g)].map(m=>m[1]));
  for(const method of ['thread/start','thread/read','thread/resume','thread/fork','turn/start','turn/interrupt','thread/queue/list','thread/queue/add','thread/settings/update','thread/goal/get','thread/backgroundTerminals/list']) {
    if(!methods.has(method))throw new Error(`Required protocol method missing: ${method}`);
  }
  const smoke=await run(process.execPath,[path.join(appRoot,'maintenance/codex-upgrade-smoke.mjs'),binary],{timeout:120000,maxBuffer:65536});
  const records=smoke.stdout.trim().split('\n').map(line=>JSON.parse(line));
  if(!records.some(r=>r.passed===true&&r.accountCredentialsUsed===false))throw new Error('Isolated compatibility test did not pass');
  const prediction=records.find(r=>r.predictionRequest);
  writeState(candidateFile,{version,validated:true,validatedAt:new Date().toISOString(),previousVersion:previous?.version??null,prediction:prediction?.predictionRequest??'unknown',predictionReason:prediction?.reason??null});
  report('validated_waiting_for_idle',{version,prediction:prediction?.predictionRequest??'unknown'});
}
main().catch(error=>{report('failed',{error:error.message});process.exitCode=1;});
