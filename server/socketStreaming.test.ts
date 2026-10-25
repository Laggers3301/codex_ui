import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {WebSocket} from 'ws';
import {expect,it,vi} from 'vitest';
import type {CodexBridge} from './codexBridge.js';
import {ProjectStore} from './db.js';
import {attachSocketServer} from './socket.js';
import {createSessionCookie} from './auth.js';

it('sends public reasoning before tools/body and restores it once over a fixture WebSocket reconnect',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'socket-reasoning-'));
 const store=new ProjectStore(path.join(directory,'store.sqlite'));
 const project=store.createProject({name:'fixture',rootPath:directory});
 store.registerThreadOwner({threadId:'thread',userId:'admin',projectId:project.id,rootPath:directory});
 const bridge=Object.assign(new EventEmitter(),{getPendingServerRequests:()=>[],request:async()=>({data:[]})});
 const server=http.createServer(),wss=attachSocketServer(server,bridge as unknown as CodexBridge,store);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const sockets:WebSocket[]=[];
 const connect=async()=>{
  const messages:any[]=[];
  const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws`,{headers:{cookie:createSessionCookie('admin').split(';')[0]}});
  sockets.push(socket);socket.on('message',raw=>messages.push(JSON.parse(String(raw))));
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='hello')).toBe(true));return messages;
 };
 const send=(method:string,extra:Record<string,unknown>={})=>bridge.emit('notification',{method,params:{threadId:'thread',turnId:'turn',...extra}});
 try{
  const messages=await connect();send('turn/started');
  send('item/started',{item:{id:'reason',type:'reasoning',summary:[],encrypted_content:'must-not-publish'}});
  send('item/reasoning/summaryTextDelta',{itemId:'reason',summaryIndex:0,delta:'公开摘要'});
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='live.reasoning'&&m.data.text==='公开摘要')).toBe(true));
  expect(messages.some(m=>m.type==='live.tool'||m.type==='live.agent')).toBe(false);
  send('item/started',{item:{id:'tool',type:'commandExecution',command:'fixture'}});
  send('item/agentMessage/delta',{itemId:'answer',delta:'正文'});
  const restored=await connect();
  const summary=restored.find(m=>m.type==='hello').data.liveState.reasoningMessages;
  expect(summary).toHaveLength(1);expect(summary[0]).toMatchObject({itemId:'reason',text:'公开摘要',completed:false});
  expect(JSON.stringify(summary)).not.toContain('must-not-publish');
  send('item/completed',{item:{id:'reason',type:'reasoning',summary:[{text:'完整公开摘要'}]}});
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='live.reasoning'&&m.data.completed)).toBe(true));
  expect(store.readTimelineItem('thread','reason')).toMatchObject({type:'reasoning',summary:['完整公开摘要'],completed:true});
  send('turn/completed',{turn:{id:'turn',status:'completed'}});
  expect(store.readTimelineItems('thread','turn').filter(i=>i.id==='reason')).toHaveLength(1);
 }finally{sockets.forEach(s=>s.terminate());wss.clients.forEach(s=>s.terminate());await new Promise<void>(r=>wss.close(()=>server.close(()=>r())));store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

it('negotiates compact updates per connection and flushes complete text before turn completion',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'socket-streaming-'));
 const store=new ProjectStore(path.join(directory,'store.sqlite'));
 const project=store.createProject({name:'fixture',rootPath:directory});
 store.registerThreadOwner({threadId:'thread',turnId:undefined,userId:'admin',projectId:project.id,rootPath:directory} as any);
 const bridge=Object.assign(new EventEmitter(),{getPendingServerRequests:()=>[],request:async()=>({data:[]})});
 const server=http.createServer();const wss=attachSocketServer(server,bridge as unknown as CodexBridge,store);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`ws://127.0.0.1:${(server.address() as any).port}/ws`;
 const records:any[][]=[[],[]];const sockets:WebSocket[]=[];
 try{
  for(let i=0;i<2;i++){
   const socket=new WebSocket(url+(i?'?agent_deltas=1':''),{headers:{cookie:createSessionCookie('admin').split(';')[0]}});sockets.push(socket);
   socket.on('message',raw=>records[i].push(JSON.parse(String(raw))));
   await vi.waitFor(()=>expect(records[i].some(m=>m.type==='hello')).toBe(true));
  }
  const send=(method:string,params:unknown)=>bridge.emit('notification',{method,params});
  send('turn/started',{threadId:'thread',turn:{id:'turn'}});
  for(const delta of ['中文🙂','\n\n','final'])send('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'item',delta});
  send('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
  await vi.waitFor(()=>expect(records[1].filter(m=>m.type==='live.agent.delta')).toHaveLength(3));
  const full=records[0].filter(m=>m.type==='live.agent');const compact=records[1].filter(m=>m.type==='live.agent.delta');
  expect(full.map(m=>m.data.text)).toEqual(['中文🙂','中文🙂\n\n','中文🙂\n\nfinal']);
  expect(compact.map(m=>m.data.delta)).toEqual(['中文🙂','\n\n','final']);
  expect(compact.map(m=>m.data.textOffset)).toEqual([0,4,6]);expect(compact.every(m=>m.data.text===undefined)).toBe(true);
  expect(store.readTimelineItems('thread','turn').find(item=>item.id==='item')?.text).toBe('中文🙂\n\nfinal');
 }finally{sockets.forEach(s=>s.terminate());wss.clients.forEach(s=>s.terminate());await new Promise<void>(r=>wss.close(()=>server.close(()=>r())));store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

it('retires disconnected drafts only after successful native completion, over real WebSockets and across reconnect',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'socket-recovered-stream-'));
 const store=new ProjectStore(path.join(directory,'store.sqlite'));
 const project=store.createProject({name:'fixture',rootPath:directory});
 store.registerThreadOwner({threadId:'thread',userId:'admin',projectId:project.id,rootPath:directory});
 const bridge=Object.assign(new EventEmitter(),{getPendingServerRequests:()=>[],request:async()=>({data:[]})});
 const server=http.createServer(),wss=attachSocketServer(server,bridge as unknown as CodexBridge,store);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const sockets:WebSocket[]=[],records:any[][]=[];
 const connect=async()=>{
  const messages:any[]=[];records.push(messages);
  const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/ws?agent_deltas=1`,{headers:{cookie:createSessionCookie('admin').split(';')[0]}});sockets.push(socket);
  socket.on('message',raw=>messages.push(JSON.parse(String(raw))));
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='hello')).toBe(true));return messages;
 };
 try{
  const messages=await connect();
  const send=(method:string,params:unknown)=>bridge.emit('notification',{method,params});
  send('turn/started',{threadId:'thread',turn:{id:'turn'}});
  send('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'draft',delta:'没有完整'});
  send('error',{threadId:'thread',turnId:'turn',willRetry:true,error:{message:'stream disconnected before completion'}});
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='live.agent'&&m.data.streamState==='interrupted')).toBe(true));
  expect(store.readTimelineItem('thread','draft')).toMatchObject({text:'没有完整',completed:false,streamState:'interrupted'});
  send('item/completed',{threadId:'thread',turnId:'turn',item:{id:'tool',type:'commandExecution',command:'fixture',output:'done'}});
  expect(store.readTimelineItem('thread','draft')?.streamState).toBe('interrupted');
  send('item/completed',{threadId:'thread',turnId:'turn',item:{id:'replacement',type:'agentMessage',text:'完整回复。'}});
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='live.agent'&&m.data.itemId==='draft'&&m.data.streamState==='superseded')).toBe(true));
  const restored=await connect(),hello=restored.find(m=>m.type==='hello');
  expect(hello.data.liveState.agentMessages.find((m:any)=>m.itemId==='draft')).toMatchObject({text:'没有完整',streamState:'superseded',completed:false});
  expect(store.readTimelineItem('thread','replacement')).toMatchObject({text:'完整回复。',streamState:'completed',completed:true});
  expect(store.readTimelineItem('thread','tool')).toBeTruthy();
  send('turn/completed',{threadId:'thread',turn:{id:'turn',status:'completed'}});
  await vi.waitFor(()=>expect(messages.some(m=>m.type==='codex.notification'&&m.data.method==='turn/completed')).toBe(true));
  expect(store.readTimelineItem('thread','draft')?.completed).toBe(false);
 }finally{sockets.forEach(s=>s.terminate());wss.clients.forEach(s=>s.terminate());await new Promise<void>(r=>wss.close(()=>server.close(()=>r())));store.close();fs.rmSync(directory,{recursive:true,force:true});}
});
