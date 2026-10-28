import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const binary=process.env.CODEX_NATIVE_TEST_BIN;
if(!binary)throw new Error('Set CODEX_NATIVE_TEST_BIN to the native Codex executable to test.');
const version=execFileSync(binary,['--version'],{encoding:'utf8'}).trim();
const root=await fs.mkdtemp(path.join(os.tmpdir(),'lzc-native-tool-output-'));await fs.mkdir(path.join(root,'home'));await fs.mkdir(path.join(root,'workspace'));
const requests=[];let holdNext=false,releaseHeld=null;
const server=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 if(!req.url.endsWith('/responses')){res.writeHead(404);res.end();return;}
 requests.push(JSON.parse(body));
 const id='resp_'+requests.length,item={id:'msg_'+requests.length,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'native-stub-ok',annotations:[]}]};
 const response={id,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'fixture-model',output:[item],usage:{input_tokens:10,output_tokens:3,total_tokens:13,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});let seq=0;
 const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:seq++,...data})+'\n\n');
 const finish=()=>{
 emit('response.created',{response:{...response,status:'in_progress',output:[]}});
 emit('response.output_item.added',{output_index:0,item:{...item,status:'in_progress',content:[]}});
 emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
 emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:'native-stub-ok'});
 emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:'native-stub-ok'});
 emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});
 emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response});res.end();};
 if(holdNext){holdNext=false;releaseHeld=finish;}else finish();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port+'/v1';
const args=['-c','model="fixture-model"','-c','model_provider="fixture"','-c',`model_providers.fixture={name="Isolated fixture",base_url="${base}",wire_api="responses",env_key="CODEX_TASK_STUB_KEY",supports_websockets=false}`,'app-server'];
const proc=spawn(binary,args,{cwd:path.join(root,'workspace'),env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:path.join(root,'home'),CODEX_TASK_STUB_KEY:'local-fixture-only',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
let buffer='',stderr='',serial=0;const pending=new Map(),events=[];
proc.stderr.on('data',data=>{stderr=(stderr+data).slice(-12000);});
proc.stdout.on('data',data=>{buffer+=data;for(;;){const i=buffer.indexOf('\n');if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let msg;try{msg=JSON.parse(line);}catch{continue;}if(msg.id!=null&&pending.has(msg.id)){const slot=pending.get(msg.id);pending.delete(msg.id);clearTimeout(slot.timer);msg.error?slot.reject(new Error(JSON.stringify(msg.error))):slot.resolve(msg.result);}else events.push(msg);}});
const call=(method,params)=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout '+method+' '+stderr.slice(-800)));},20000);pending.set(id,{resolve,reject,timer});proc.stdin.write(JSON.stringify({id,method,params})+'\n');});
const waitComplete=async(threadId,turnId)=>{const end=Date.now()+20000;while(Date.now()<end){const event=events.find(e=>e.method==='turn/completed'&&e.params.threadId===threadId&&e.params.turn.id===turnId);if(event){assert.equal(event.params.turn.status,'completed',JSON.stringify(event.params.turn));return;}await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('turn did not complete '+stderr.slice(-1000));};
try{
 await call('initialize',{clientInfo:{name:'isolated-session-task-probe',version:'1.0.0'},capabilities:{experimentalApi:true}});proc.stdin.write(JSON.stringify({method:'initialized'})+'\n');
 const start=await call('thread/start',{cwd:path.join(root,'workspace'),model:'fixture-model',approvalPolicy:'never',sandbox:'read-only',ephemeral:true});
 const target=await call('thread/start',{cwd:path.join(root,'workspace'),model:'fixture-model',approvalPolicy:'never',sandbox:'read-only',ephemeral:true});
 const a=start.thread.id,b=target.thread.id;
 const first=await call('turn/start',{threadId:a,input:[{type:'text',text:'source task',text_elements:[]}]});await waitComplete(a,first.turn.id);
 const delegated=await call('turn/start',{threadId:b,input:[{type:'text',text:'delegated task',text_elements:[]}],parentTurnId:first.turn.id,rootTurnId:first.turn.id});await waitComplete(b,delegated.turn.id);
 const output={type:'session_task_result',taskId:'isolated-task',status:'succeeded',result:'DELEGATED_RESULT_MARKER'};
 const continued=await call('turn/start',{threadId:a,input:[],parentTurnId:delegated.turn.id,rootTurnId:first.turn.id,toolOutput:{name:'session_communication',namespace:'codex_communication',retain:true,output:JSON.stringify(output)}});await waitComplete(a,continued.turn.id);
 assert.equal(requests.length,3);assert.ok(JSON.stringify(requests.at(-1)).includes('DELEGATED_RESULT_MARKER'));
 holdNext=true;
 const activeSource=await call('turn/start',{threadId:a,input:[{type:'text',text:'keep this source generation active',text_elements:[]}]});
 const holdDeadline=Date.now()+5000;while(!releaseHeld&&Date.now()<holdDeadline)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(releaseHeld);
 const nextTarget=await call('turn/start',{threadId:b,input:[{type:'text',text:'another delegated task',text_elements:[]}]});await waitComplete(b,nextTarget.turn.id);
 const queuedOutput=await call('turn/start',{threadId:a,input:[],toolOutput:{name:'session_communication',namespace:'codex_communication',retain:true,output:JSON.stringify({...output,result:'ACTIVE_RESULT_MARKER'})}});
 assert.equal(queuedOutput.turn.id,activeSource.turn.id,'active tool output stays within the original source turn');
 releaseHeld();releaseHeld=null;await waitComplete(a,activeSource.turn.id);
 assert.ok(requests.some(request=>JSON.stringify(request).includes('ACTIVE_RESULT_MARKER')),'the active source model receives queued native tool output');
 console.log(JSON.stringify({isolatedHome:true,localStubModelOnly:true,realCodexVersion:version,twoExistingThreads:true,delegatedNativeTurn:true,sourceAutoContinuedByToolOutput:true,activeSourceGetsToolOutputInSameTurn:true,requests:requests.length}));
}catch(error){console.error(String(error));console.error(stderr.slice(-3000));process.exitCode=1;}finally{for(const slot of pending.values()){clearTimeout(slot.timer);slot.reject(new Error('probe closed'));}proc.stdin.end();proc.kill('SIGTERM');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(root,{recursive:true,force:true});}
