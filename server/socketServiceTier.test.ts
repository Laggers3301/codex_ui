import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { createSessionCookie } from "./auth.js";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { attachSocketServer } from "./socket.js";

class TierBridge extends EventEmitter {
  calls: Array<{method:string;params:any}> = [];
  getPendingServerRequests() { return []; }
  async request(method:string,params:any) {
    this.calls.push({method,params});
    if(method === "thread/start") return {thread:{id:"tier-thread"}};
    if(method === "turn/start") return {turn:{id:"tier-turn"}};
    if(method === "thread/queue/list") return {data:[]};
    return {};
  }
}

it("forwards new-thread Fast and updates queued Fast Off without interrupting the active turn", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"socket-tier-"));
  const store=new ProjectStore(path.join(root,"store.sqlite"));
  const project=store.createProject({name:"tier",rootPath:root,defaultModel:"gpt-6.1-sol"});
  const bridge=new TierBridge(),server=http.createServer();
  const wss=attachSocketServer(server,bridge as unknown as CodexBridge,store);
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const socket=new WebSocket(`ws://127.0.0.1:${(server.address() as {port:number}).port}/ws`,{headers:{cookie:createSessionCookie("admin")}});
  const messages:any[]=[];socket.on("message",raw=>messages.push(JSON.parse(String(raw))));
  const wait=async(predicate:(message:any)=>boolean)=>{
    const until=Date.now()+5000;
    while(Date.now()<until){const message=messages.find(predicate);if(message)return message;await new Promise(r=>setTimeout(r,5));}
    throw new Error("Tier socket timeout");
  };
  try {
    await wait(m=>m.type==="hello");
    socket.send(JSON.stringify({type:"thread.start",requestId:"tier-new",projectId:project.id,prompt:"Fast test",serviceTier:"fast"}));
    const ack=await wait(m=>m.requestId==="tier-new");expect(ack.ok,ack.error).toBe(true);
    expect(bridge.calls.find(c=>c.method==="thread/start")?.params.serviceTier).toBe("fast");
    expect(bridge.calls.find(c=>c.method==="turn/start")?.params).toMatchObject({serviceTier:"fast",serviceTierForTurn:"priority"});
    socket.send(JSON.stringify({type:"turn.queue.add",requestId:"tier-queue",threadId:"tier-thread",prompt:"Next at standard speed",serviceTier:null}));
    const queued=await wait(m=>m.requestId==="tier-queue");expect(queued.ok,queued.error).toBe(true);
    const update=bridge.calls.findIndex(c=>c.method==="thread/settings/update");
    const enqueue=bridge.calls.findIndex(c=>c.method==="thread/queue/add");
    expect(update).toBeGreaterThan(-1);expect(enqueue).toBeGreaterThan(update);
    expect(bridge.calls[update].params).toEqual({threadId:"tier-thread",serviceTier:null});
    expect(bridge.calls.some(c=>c.method==="turn/interrupt")).toBe(false);
    await new Promise(r=>setTimeout(r,20));
  } finally {
    socket.terminate();
    await new Promise<void>(resolve=>wss.close(()=>server.close(()=>resolve())));
    store.close();fs.rmSync(root,{recursive:true,force:true});
  }
});
