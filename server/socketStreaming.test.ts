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
