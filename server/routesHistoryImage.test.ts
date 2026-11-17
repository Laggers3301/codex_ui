import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import {expect,it,vi} from 'vitest';
import type {CodexBridge} from './codexBridge.js';
import type {ProjectStore} from './db.js';

vi.mock('./auth.js',async original=>({...await original<object>(),authenticatedUserFromHeaders:vi.fn((headers:Record<string,string>)=>headers['x-fixture-user']??null)}));
vi.mock('./threadFallback.js',async original=>({...await original<object>(),findThreadJsonlPathById:vi.fn()}));
import {findThreadJsonlPathById} from './threadFallback.js';
import {registerRoutes} from './routes.js';

it('authorizes the thread before locating or streaming image bytes; rejects forged ranges',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'image-route-'));
  const app=Fastify();let calls=0;
  const bridge=Object.assign(new EventEmitter(),{request:()=>{calls++;throw Error('Native requests forbidden');}});
  const store={ensureUser:(id:string)=>({id}),userCanAccessThread:(id:string,user:string)=>user==='image-owner'&&id==='thread'};
  registerRoutes(app,bridge as unknown as CodexBridge,store as unknown as ProjectStore,{backgroundIndexing:false,browserTools:false});
  try{
    const file=path.join(directory,'rollout.jsonl'),bytes=Buffer.from([137,80,78,71,13,10,26,10]),url='data:image/png;base64,'+bytes.toString('base64');
    const source=JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',output:[{type:'input_image',image_url:url}]}})+'\n';
    await fs.writeFile(file,source);vi.mocked(findThreadJsonlPathById).mockResolvedValue(file);
    const start=source.indexOf(url),end=start+url.length,endpoint=`/api/threads/thread/history-image?start=${start}&end=${end}`;
    for(const user of [undefined,'other']){
      const result=await app.inject({url:endpoint,headers:user?{'x-fixture-user':user}:{}});
      expect(result.statusCode).toBe(403);
    }
    expect(findThreadJsonlPathById).not.toHaveBeenCalled();
    const result=await app.inject({url:endpoint,headers:{'x-fixture-user':'image-owner'}});
    expect(result.statusCode,result.body).toBe(200);expect(result.rawPayload).toEqual(bytes);
    expect(result.headers['content-type']).toBe('image/png');expect(result.headers['cache-control']).toBe('private, no-store');expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect((await app.inject({url:endpoint.replace(`start=${start}`,`start=${start+1}`),headers:{'x-fixture-user':'image-owner'}})).statusCode).toBe(400);
    expect((await app.inject({url:'/api/threads/other/history-image?start=1&end=10',headers:{'x-fixture-user':'image-owner'}})).statusCode).toBe(403);
    expect(calls).toBe(0);expect(await fs.readFile(file,'utf8')).toBe(source);
  }finally{await app.close();vi.restoreAllMocks();await fs.rm(directory,{recursive:true,force:true});}
});
