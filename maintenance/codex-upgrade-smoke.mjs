import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import assert from 'node:assert/strict';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-upgrade-smoke-'));
let calls=0;
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;
 if(!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
 calls++;
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const emit=x=>res.write(`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`);
 const response={id:`resp_${calls}`,object:'response',model:'gpt-6.1-sol',status:'in_progress',output:[]};
 emit({type:'response.created',response});
 if(calls===1){res.end();return;}
 const item={id:`msg_${calls}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'测试通过',annotations:[]}]};
 emit({type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}});
 emit({type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
 emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'测试通过'});
 emit({type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:'测试通过'});
 emit({type:'response.output_item.done',output_index:0,item});
 emit({type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:2,total_tokens:3,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}});
 res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const bin=process.argv[2];
if(!bin)throw new Error('Missing isolated Codex binary');
const child=spawn(bin,['app-server','--listen','stdio://','-c','model="gpt-6.1-sol"','-c','model_provider="retry_test"','-c',`model_providers.retry_test={name="Local retry test",base_url="http://127.0.0.1:${port}/v1",env_key="RETRY_TEST_KEY",wire_api="responses",request_max_retries=0,stream_max_retries=0}`],{cwd:home,env:{...process.env,CODEX_HOME:home,RETRY_TEST_KEY:'local-dummy-not-a-real-key',NO_PROXY:'127.0.0.1,localhost'},stdio:['pipe','pipe','pipe']});
let seq=0,stderr='',events=[];const pending=new Map();
child.stderr.on('data',c=>stderr=(stderr+c).slice(-1500));
readline.createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method)events.push(m);}catch{}});
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout '+stderr));},15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
async function completed(turnId){const end=Date.now()+20000;while(Date.now()<end){const x=events.find(e=>e.method==='turn/completed'&&e.params.turn.id===turnId);if(x)return x.params.turn;await new Promise(r=>setTimeout(r,50));}throw new Error('completion timeout '+stderr);}
try{
 await rpc('initialize',{clientInfo:{name:'native_retry_test',version:'1'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');
 const created=await rpc('thread/start',{model:'gpt-6.1-sol',cwd:home,approvalPolicy:'never',sandbox:'read-only'}),id=created.thread.id;
 const first=await rpc('turn/start',{threadId:id,input:[{type:'text',text:'仅回复测试通过，不调用工具。'}],model:'gpt-6.1-sol',effort:'low'});
 const failed=await completed(first.turn.id);assert.equal(failed.status,'failed');assert.match(failed.error.message,/stream.*(?:closed|disconnected)/i);
 const status=await rpc('thread/read',{threadId:id,includeTurns:false});
 await rpc('thread/resume',{threadId:id,model:'gpt-6.1-sol',cwd:home,excludeTurns:true});
 const second=await rpc('turn/start',{threadId:id,input:[{type:'text',text:'这是用户的新提问，仅回复测试通过，不调用工具。'}],model:'gpt-6.1-sol',effort:'low'});
 const done=await completed(second.turn.id);assert.equal(done.status,'completed');
 try { await rpc('thread/prediction/request',{threadId:id,sourceTurnId:second.turn.id}); console.log(JSON.stringify({predictionRequest:'accepted'})); } catch(error) { console.log(JSON.stringify({predictionRequest:'rejected',reason:error.message,additionalHttpCalls:calls-2})); }
 const loadedSettings=await rpc('thread/settings/update',{threadId:id,permissions:':read-only',approvalPolicy:'never'});
 assert.ok(loadedSettings);
 const queued=await rpc('thread/queue/add',{threadId:id,input:[{type:'text',text:'仅回复测试通过。'}],clientUserMessageId:'upgrade-smoke-queue'});
 await new Promise(r=>setTimeout(r,100));
 let qturn=events.findLast(e=>e.method==='turn/started'&&e.params.turn.id!==second.turn.id&&e.params.turn.id!==first.turn.id);
 if(!qturn){await rpc('thread/queue/start',{threadId:id});await new Promise(r=>setTimeout(r,100));qturn=events.findLast(e=>e.method==='turn/started'&&e.params.turn.id!==second.turn.id&&e.params.turn.id!==first.turn.id);}
 assert.ok(qturn);assert.equal((await completed(qturn.params.turn.id)).status,'completed');
 console.log(JSON.stringify({passed:true,firstStatus:failed.status,runtimeStatusAfterFailure:status.thread.status,secondStatus:done.status,sameThread:true,httpCalls:calls,unsubscribed:false,accountCredentialsUsed:false}));
}finally{child.kill();server.close();for(const p of pending.values())clearTimeout(p.timer);}
