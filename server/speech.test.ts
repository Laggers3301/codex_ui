import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "./auth.js";
import { registerSpeechRoutes } from "./speech.js";
import http from 'node:http';

const recognized={text:'你好 Codex',elapsedMs:20,durationSeconds:1,model:'Qwen3-ASR-1.7B'};
const ownerHeaders={cookie:createSessionCookie('qa-user').split(';')[0]};
const audioPrefix='--speech\r\nContent-Disposition: form-data; name="audio"; filename="recording"\r\nContent-Type: audio/webm\r\n\r\naudio bytes';
const audioBody=audioPrefix+'\r\n--speech--\r\n';
async function lifetimeFixture(uploadTimeoutMs=500,transcriptionTimeoutMs=1000){
 const app=Fastify();await app.register(multipart);
 const transcribe=vi.fn().mockResolvedValue(recognized);
 registerSpeechRoutes(app,{transcribe,ready:async()=>true,uploadTimeoutMs,transcriptionTimeoutMs});
 const base=await app.listen({host:'127.0.0.1',port:0});
 const status=async()=>(await app.inject({url:'/api/speech/status',headers:ownerHeaders})).json();
 const send=(headers=ownerHeaders)=>app.inject({method:'POST',url:'/api/speech/transcribe',headers:{...headers,'content-type':'multipart/form-data; boundary=speech'},payload:audioBody});
 const open=(route='/api/speech/transcribe')=>{
  let client!:http.ClientRequest;
  const response=new Promise<{status:number;body:string}>(resolve=>{
   client=http.request(base+route,{method:'POST',agent:false,headers:{...ownerHeaders,'content-type':'multipart/form-data; boundary=speech'}},res=>{
    let body='';res.on('data',part=>{body+=part;});res.on('end',()=>resolve({status:res.statusCode??0,body}));res.on('error',()=>resolve({status:0,body:''}));
   });client.on('error',()=>resolve({status:0,body:''}));
  });
  return {client,response};
 };
 return {app,transcribe,status,send,open};
}

describe("authenticated dictation", () => {
  it('coalesces slow health checks across users, expires cached failures and recovers',async()=>{
    const app=Fastify();let release!:(value:boolean)=>void;
    const ready=vi.fn().mockImplementation(()=>new Promise<boolean>(resolve=>{release=resolve;}));
    registerSpeechRoutes(app,{ready,healthCacheMs:20});
    try{
      const requests=[ownerHeaders,{cookie:createSessionCookie('sample-user').split(';')[0]},ownerHeaders].map(headers=>app.inject({url:'/api/speech/status',headers}));
      const results=Promise.all(requests);
      await vi.waitFor(()=>expect(ready).toHaveBeenCalledTimes(1));release(true);
      expect((await results).every(response=>response.json().ready===true)).toBe(true);
      expect((await app.inject({url:'/api/speech/status',headers:ownerHeaders})).json().ready).toBe(true);
      expect(ready).toHaveBeenCalledTimes(1);
      await new Promise(resolve=>setTimeout(resolve,25));ready.mockRejectedValueOnce(new Error('network timeout'));
      expect((await app.inject({url:'/api/speech/status',headers:ownerHeaders})).json().ready).toBe(false);
      expect((await app.inject({url:'/api/speech/status',headers:ownerHeaders})).json().ready).toBe(false);
      expect(ready).toHaveBeenCalledTimes(2);
      await new Promise(resolve=>setTimeout(resolve,25));ready.mockResolvedValueOnce(true);
      expect((await app.inject({url:'/api/speech/status',headers:ownerHeaders})).json().ready).toBe(true);
      expect(ready).toHaveBeenCalledTimes(3);
    }finally{await app.close();}
  });
  it('times out an unfinished upload before inference and releases the owner lock',async()=>{
    const f=await lifetimeFixture(),slow=f.open();slow.client.write(audioPrefix);
    try{
      await vi.waitFor(async()=>expect((await f.status()).busy).toBe(true),{interval:10});
      expect((await f.send()).statusCode).toBe(429);
      const response=await slow.response;expect(response.status).toBe(408);expect(response.body).toContain('上传超时');
      expect(f.transcribe).not.toHaveBeenCalled();
      expect((await f.status()).busy).toBe(false);
      expect((await f.send()).statusCode).toBe(200);expect(f.transcribe).toHaveBeenCalledTimes(1);
    }finally{slow.client.destroy();await f.app.close();}
  });
  it('releases a disconnected upload immediately and leaves other users usable',async()=>{
    const f=await lifetimeFixture(5000),slow=f.open();slow.client.write(audioPrefix);
    try{
      await vi.waitFor(async()=>expect((await f.status()).busy).toBe(true),{interval:10});
      expect((await f.send({cookie:createSessionCookie('sample-user').split(';')[0]})).statusCode).toBe(200);
      slow.client.destroy();
      await vi.waitFor(async()=>expect((await f.status()).busy).toBe(false),{interval:10});
      expect((await f.send()).statusCode).toBe(200);expect(f.transcribe).toHaveBeenCalledTimes(2);
    }finally{slow.client.destroy();await f.app.close();}
  });
  it('cancels a stalled preupload and frees transfer slots without retaining an owner session',async()=>{
    const f=await lifetimeFixture(5000);
    const session=(await f.app.inject({method:'POST',url:'/api/speech/uploads',headers:ownerHeaders,payload:{mime:'audio/webm'}})).json();
    const slow=f.open(`/api/speech/uploads/${session.id}/0`);slow.client.write(audioPrefix);
    try{
      await vi.waitFor(async()=>expect((await f.status()).uploading).toBe(true),{interval:10});
      expect((await f.app.inject({method:'DELETE',url:`/api/speech/uploads/${session.id}`,headers:ownerHeaders})).statusCode).toBe(200);
      await slow.response;
      await vi.waitFor(async()=>expect((await f.status()).uploading).toBe(false),{interval:10});
      expect((await f.app.inject({method:'POST',url:'/api/speech/uploads',headers:ownerHeaders,payload:{mime:'audio/webm'}})).statusCode).toBe(200);
      expect(f.transcribe).not.toHaveBeenCalled();
    }finally{slow.client.destroy();await f.app.close();}
  });
  it('times out a partial final fragment and removes its cancelled session',async()=>{
    const f=await lifetimeFixture();
    const session=(await f.app.inject({method:'POST',url:'/api/speech/uploads',headers:ownerHeaders,payload:{mime:'audio/webm'}})).json();
    const slow=f.open(`/api/speech/uploads/${session.id}/complete`);
    slow.client.write('--speech\r\nContent-Disposition: form-data; name="parts"\r\n\r\n0\r\n'+audioPrefix);
    try{
      const response=await slow.response;expect(response.status).toBe(408);
      expect((await f.app.inject({method:'POST',url:'/api/speech/uploads',headers:ownerHeaders,payload:{mime:'audio/webm'}})).statusCode).toBe(200);
      expect(f.transcribe).not.toHaveBeenCalled();
    }finally{slow.client.destroy();await f.app.close();}
  });
  it('aborts inference on browser disconnect and ignores a late result without clearing a newer lock',async()=>{
    const f=await lifetimeFixture(5000,5000),first=f.open();
    let finishFirst!:(value:typeof recognized)=>void,finishSecond!:(value:typeof recognized)=>void;
    f.transcribe.mockImplementationOnce(()=>new Promise(resolve=>{finishFirst=resolve;})).mockImplementationOnce(()=>new Promise(resolve=>{finishSecond=resolve;}));
    first.client.end(audioBody);
    try{
      await vi.waitFor(()=>expect(f.transcribe).toHaveBeenCalledTimes(1),{interval:10});
      const firstSignal=f.transcribe.mock.calls[0][1] as AbortSignal;
      first.client.destroy();await vi.waitFor(async()=>expect((await f.status()).busy).toBe(false),{interval:10});
      expect(firstSignal.aborted).toBe(true);
      const second=f.send().then(result=>result);
      await vi.waitFor(()=>expect(f.transcribe).toHaveBeenCalledTimes(2),{interval:10});
      finishFirst(recognized);await new Promise(resolve=>setImmediate(resolve));
      expect((await f.status()).busy).toBe(true);expect((await f.send()).statusCode).toBe(429);
      finishSecond(recognized);expect((await second).statusCode).toBe(200);
      expect((await f.status()).busy).toBe(false);expect(f.transcribe).toHaveBeenCalledTimes(2);
    }finally{finishFirst?.(recognized);finishSecond?.(recognized);first.client.destroy();await f.app.close();}
  });
  it('bounds inference even when the adapter ignores cancellation',async()=>{
    const f=await lifetimeFixture(1000,40);f.transcribe.mockImplementationOnce(()=>new Promise(()=>{}));
    try{
      expect((await f.send()).statusCode).toBe(503);
      expect((await f.status()).busy).toBe(false);
      expect((await f.send()).statusCode).toBe(200);expect(f.transcribe).toHaveBeenCalledTimes(2);
    }finally{await f.app.close();}
  });
  it("rejects unauthenticated access and exposes the real model", async () => {
    const app = Fastify(); await app.register(multipart);
    registerSpeechRoutes(app, { ready: async () => true });
    try {
      expect((await app.inject({ url: "/api/speech/status" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/api/speech/status", headers: { cookie: createSessionCookie("qa-user").split(";")[0] } })).json()).toMatchObject({ ready: true, model: "Qwen3-ASR-1.7B" });
    } finally { await app.close(); }
  });
  it("transcribes only audio, preserves Chinese/English, and safely reports upstream failure", async () => {
    const app = Fastify(); await app.register(multipart);
    const transcribe = vi.fn().mockResolvedValue({ text: "你好 Codex", elapsedMs: 120, durationSeconds: 2, model: "Qwen3-ASR-1.7B" });
    registerSpeechRoutes(app, { transcribe });
    const send = (mime: string) => app.inject({ method: "POST", url: "/api/speech/transcribe", headers: { cookie: createSessionCookie("qa-user").split(";")[0], "content-type": "multipart/form-data; boundary=speech" }, payload: `--speech\r\nContent-Disposition: form-data; name="audio"; filename="recording"\r\nContent-Type: ${mime}\r\n\r\naudio bytes\r\n--speech--\r\n` });
    try {
      expect((await send("text/plain")).statusCode).toBe(415);
      expect(transcribe).not.toHaveBeenCalled();
      expect((await send("audio/mp4")).json().text).toBe("你好 Codex");
      transcribe.mockRejectedValueOnce(Object.assign(new Error("没有识别到文字"), { statusCode: 422 }));
      expect((await send("audio/webm")).statusCode).toBe(422);
      transcribe.mockRejectedValueOnce(new Error("private network detail"));
      const response = await send("audio/webm");
      expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private network");
    } finally { await app.close(); }
  });
  it("preuploads ordered fragments, isolates owners, removes cancelled audio and completes once", async () => {
    const app = Fastify(); await app.register(multipart);
    const transcribe = vi.fn().mockResolvedValue({ text: "你好 Codex", elapsedMs: 50, durationSeconds: 8, model: "Qwen3-ASR-1.7B" });
    registerSpeechRoutes(app, { transcribe });
    const headers = { cookie: createSessionCookie("qa-user").split(";")[0] };
    const other = { cookie: createSessionCookie("sample-user").split(";")[0] };
    const create = () => app.inject({ method: "POST", url: "/api/speech/uploads", headers, payload: { mime: "audio/mp4" } });
    const part = (id: string, index: number, text: string, owner = headers) => app.inject({ method: "POST", url: `/api/speech/uploads/${id}/${index}`, headers: { ...owner, "content-type": "multipart/form-data; boundary=speech" }, payload: `--speech\r\nContent-Disposition: form-data; name="audio"; filename="fragment"\r\nContent-Type: audio/mp4\r\n\r\n${text}\r\n--speech--\r\n` });
    try {
      expect((await app.inject({ method: "POST", url: "/api/speech/uploads", payload: { mime: "audio/mp4" } })).statusCode).toBe(401);
      const { id } = (await create()).json();
      expect((await create()).statusCode).toBe(429);
      expect((await part(id, 0, "steal", other)).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/speech/uploads/${id}`, headers: other })).statusCode).toBe(404);
      expect((await part(id, 1, "second")).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/speech/uploads/${id}/complete`, headers, payload: { parts: 2 } })).statusCode).toBe(409);
      expect((await part(id, 0, "first")).statusCode).toBe(200);
      expect((await part(id, 0, "first")).statusCode).toBe(409);
      const result = await app.inject({ method: "POST", url: `/api/speech/uploads/${id}/complete`, headers, payload: { parts: 2 } });
      expect(result.json()).toMatchObject({ text: "你好 Codex", serverTimings: { uploadMs: 0 } });
      expect(transcribe.mock.calls[0][0].toString()).toBe("firstsecond");
      expect((await app.inject({ method: "POST", url: `/api/speech/uploads/${id}/complete`, headers, payload: { parts: 2 } })).statusCode).toBe(404);
      expect(transcribe).toHaveBeenCalledTimes(1);
      const next = (await create()).json().id;
      await app.inject({ method: "DELETE", url: `/api/speech/uploads/${next}`, headers });
      expect((await part(next, 0, "late")).statusCode).toBe(404);
      const tailSession = (await create()).json();
      expect(tailSession.combinedTail).toBe(true);
      const completeTail = (id: string, count: number, owner = headers) => app.inject({ method: "POST", url: `/api/speech/uploads/${id}/complete`, headers: { ...owner, "content-type": "multipart/form-data; boundary=speech" }, payload: `--speech\r\nContent-Disposition: form-data; name="parts"\r\n\r\n${count}\r\n--speech\r\nContent-Disposition: form-data; name="audio"; filename="tail"\r\nContent-Type: audio/mp4\r\n\r\ntail\r\n--speech--\r\n` });
      expect((await completeTail(tailSession.id, 0, other)).statusCode).toBe(404);
      expect((await completeTail(tailSession.id, 1)).statusCode).toBe(409);
      expect((await part(tailSession.id, 0, "prefix")).statusCode).toBe(200);
      expect((await completeTail(tailSession.id, 1)).statusCode).toBe(200);
      expect(transcribe.mock.calls[1][0].toString()).toBe("prefixtail");
      expect((await completeTail(tailSession.id, 1)).statusCode).toBe(404);
      const shortSession = (await create()).json().id;
      expect((await completeTail(shortSession, 0)).statusCode).toBe(200);
      expect(transcribe.mock.calls[2][0].toString()).toBe("tail");
      expect(transcribe).toHaveBeenCalledTimes(3);
      const longSession = (await create()).json().id;
      expect((await part(longSession, 150, "long recording fragment")).statusCode).toBe(200);
      expect((await part(longSession, 512, "out of bounds")).statusCode).toBe(400);
      await app.inject({ method: "DELETE", url: `/api/speech/uploads/${longSession}`, headers });
    } finally { await app.close(); }
  });
});
