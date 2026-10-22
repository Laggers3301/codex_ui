import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {evaluateAccount,parseDiagnostics,readTiming,deliver,readDiagnostics} from './auth-renewal-monitor.mjs';
const now=Date.parse('2026-10-20T14:00:00Z');
const meta={lastRefresh:'2026-10-11T13:44:06Z',expiresAt:'2026-10-21T13:44:06Z'};
const account={id:'100004'};
test('before window is quiet; grace is 15 minutes',()=>{
 assert.equal(evaluateAccount(account,meta,meta,[],now-3600000).event,undefined);
 assert.equal(evaluateAccount(account,meta,meta,[],Date.parse('2026-10-20T13:50:00Z')).event,undefined);
 assert.equal(evaluateAccount(account,meta,meta,[],now).event.reason,'renewal_window_no_progress');
});
test('ready or unchanged dates never prove rotation',()=>{
 assert.notEqual(evaluateAccount(account,meta,meta,[{accountId:'100004',code:'renewed'}],now).event?.kind,'success');
});
test('requires both advancing dates and native confirmation for success',()=>{
 const updated={lastRefresh:'2026-10-20T14:00:00Z',expiresAt:'2026-10-30T14:00:00Z'};
 assert.equal(evaluateAccount(account,updated,meta,[{accountId:'100004',code:'renewed',at:updated.lastRefresh}],now).event.kind,'success');
 assert.equal(evaluateAccount(account,updated,meta,[],now).event.kind,'notice');
});
test('known 0831 does not emit repeat failures; new login resumes observation',()=>{
 const a={id:'100002',knownFailure:{lastRefresh:meta.lastRefresh}};
 assert.equal(evaluateAccount(a,meta,meta,[{accountId:'100002',code:'refresh_token_unavailable'}],now).event,undefined);
 const updated={lastRefresh:'2026-10-20T14:00:00Z',expiresAt:'2026-10-30T14:00:00Z'};
 assert.equal(evaluateAccount(a,updated,meta,[],now).event.kind,'notice');
});
test('transient errors, expired access and missing metadata are distinct',()=>{
 assert.equal(evaluateAccount(account,meta,meta,[{accountId:'100004',code:'renewal_temporarily_failed'}],now).event.reason,'renewal_temporarily_failed');
 assert.equal(evaluateAccount(account,meta,meta,[],now+86400000).event.reason,'access_expired');
 assert.equal(evaluateAccount(account,{},meta,[],now).event.reason,'metadata_unavailable');
});
test('logs project only safe fields and known codes',()=>{
 const rows=parseDiagnostics(JSON.stringify({accountId:'100004',code:'renewed',time:now,token:'SECRET'})+'\nnot json');
 assert.equal(rows.length,1);assert(!JSON.stringify(rows).includes('SECRET'));
});
test('transient account_missing during login is not a terminal refresh rejection',()=>{
 const diagnostics=parseDiagnostics(JSON.stringify({accountId:'100004',code:'account_missing',time:now}));
 assert.deepEqual(diagnostics,[]);
 const updated={lastRefresh:'2026-10-20T14:00:00Z',expiresAt:'2026-10-30T14:00:00Z'};
 assert.equal(evaluateAccount(account,updated,meta,diagnostics,now).event.kind,'notice');
});
test('auth parser returns only metadata, rejects symlink and malformed token',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auth-observer-'));
 const file=path.join(dir,'auth.json');
 try {
  const access='x.'+Buffer.from(JSON.stringify({iat:now/1000,exp:now/1000+86400})).toString('base64url')+'.x';
  fs.writeFileSync(file,JSON.stringify({last_refresh:new Date(now).toISOString(),tokens:{access_token:access,refresh_token:'DO_NOT_RETURN'}}));
  assert(!JSON.stringify(readTiming(dir)).includes('DO_NOT_RETURN'));
  assert.equal(readTiming(dir).expiresAt,new Date(now+86400000).toISOString());
  fs.renameSync(file,file+'.real');fs.symlinkSync(file+'.real',file);
  assert.equal(readTiming(dir).error,'credential_metadata_unavailable');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('a queued notification is reconciled without repeated scheduling',async()=>{
 const marker='auth-monitor:test';let writes=0;
 const cfg={notification:{baseUrl:'http://127.0.0.1:4576',userId:'test',cookieName:'session',sessionSecretFile:'/dev/null',projectId:'p',threadId:'t',taskId:'s'}};
 const state={events:[{key:'k'}],deliveryBatch:{marker,keys:['k'],preparedAt:new Date(now).toISOString()}};
 await deliver(cfg,state,async(_url,options)=>{if(options.method!=='GET')writes++;return {ok:true,json:async()=>({data:[{id:'s',prompt:marker,enabled:false,history:[{scheduledAt:new Date(now+30000).toISOString(),status:'queued'}]}]})};});
 assert.equal(writes,0);assert.equal(state.events[0].delivery.status,'queued_to_conversation');
});
test('delivery refuses non-loopback targets',async()=>{
 await assert.rejects(deliver({notification:{baseUrl:'http://example.com'}},{events:[{}]}),/not_loopback/);
});
test('an empty outbox makes no requests or reads session secrets',async()=>{
 let calls=0;
 await deliver({}, {events:[]},async()=>{calls++;throw Error();});
 assert.equal(calls,0);
});
test('journal uses portable timestamps and treats empty matches as normal',async()=>{
 const rows=await readDiagnostics('test.service',now,async(_cmd,args)=>{
  assert.equal(args[args.indexOf('--since')+1],'@'+Math.floor(now/1000));
  throw Object.assign(new Error(),{code:1,stderr:''});
 });
 assert.deepEqual(rows,[]);
 await assert.rejects(readDiagnostics('test.service',now,async()=>{throw Object.assign(new Error(),{code:1,stderr:'Permission denied'});}),/journal_unavailable/);
});
test('native confirmation may arrive after metadata was observed',()=>{
 const updated={lastRefresh:'2026-10-20T14:00:00Z',expiresAt:'2026-10-30T14:00:00Z'};
 const previous={...updated,status:'advanced_without_native_confirmation'};
 assert.equal(evaluateAccount(account,updated,previous,[{accountId:'100004',code:'renewed',at:updated.lastRefresh}],now).event.kind,'success');
});
test('a quiet journal is not proof of recovery from a refresh failure',()=>{
 const previous={...meta,status:'renewal_temporarily_failed'};
 const result=evaluateAccount(account,meta,previous,[],now);
 assert.equal(result.current.status,'renewal_temporarily_failed');assert.equal(result.event,undefined);
});
test('event scheduling is durable and a repeated check does not patch twice',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auth-outbox-'));
 try {
  const cfg={stateFile:path.join(dir,'state.json'),notification:{baseUrl:'http://127.0.0.1:4576',userId:'test',cookieName:'session',sessionSecretFile:'/dev/null',projectId:'p',threadId:'t',taskId:'s'}};
  const state={events:[{key:'k',accountId:'a',reason:'test',at:new Date().toISOString()}]};
  let patches=0;const task={id:'s',enabled:false,history:[]};
  const request=async(_url,opt)=>{
   if(opt.method==='PATCH'){patches++;Object.assign(task,JSON.parse(opt.body));}
   return {ok:true,json:async()=>({data:opt.method==='GET'?[task]:task})};
  };
  await deliver(cfg,state,request);await deliver(cfg,state,request);
  assert.equal(patches,1);assert(fs.statSync(cfg.stateFile).mode & 0o600);
  assert(!fs.readFileSync(cfg.stateFile,'utf8').includes('cookie'));
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
