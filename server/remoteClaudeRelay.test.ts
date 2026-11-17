import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {describe,expect,it,vi} from 'vitest';
import {remoteSshArgs,relayRemoteRequest,startRemoteClaudeRelay,type RemoteClaudeConfig} from './remoteClaudeRelay.js';

const config:RemoteClaudeConfig={userId:'qa-user',sourceThreadId:'source-fixture',orgId:'380703',label:'fixture',host:'192.0.2.1',port:22,sshUser:'root',keyFile:'/fixture/key',knownHostsFile:'/fixture/known_hosts',accountKey:'fixture-account',deviceId:'54845',configRoot:'/fixture/config',executable:'/bin/true',models:[{key:'opus',nativeId:'claude-opus-fixture',label:'fixture',supportedEffortLevels:['high']}]};

describe('private KS relay',()=>{
  it('pins host identity and restricts the SSH command without password or forwarding',()=>{
    const args=remoteSshArgs(config,'relay');
    expect(args).toContain('BatchMode=yes');expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args.at(-1)).toBe('relay');expect(args).not.toContain('-L');
    expect(()=>remoteSshArgs({...config,host:'host; id'},'relay')).toThrow();
  });

  it('reattaches the same request with its last sequence after a connection drops',async()=>{
    const sent:any[]=[],events:any[]=[];
    const launch=vi.fn(()=>{
      const child:any=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
      let data='';child.stdin.on('data',(chunk:Buffer)=>data+=chunk.toString());
      child.stdin.on('finish',()=>{sent.push(JSON.parse(data));const rows=sent.length===1?
        [{type:'headers',seq:1,status:200},{type:'chunk',seq:2,data:'YQ=='}]:
        [{type:'chunk',seq:2,data:'YQ=='},{type:'chunk',seq:3,data:'Yg=='},{type:'end',seq:4}];
        setImmediate(()=>child.stdout.end(rows.map(row=>JSON.stringify(row)).join('\n')+'\n'));
      });return child;
    });
    await relayRemoteRequest(config,{id:'a'.repeat(64),userId:'qa-user',sourceThreadId:'source-fixture',cursor:0,body:'fixture'},async event=>{events.push(event);},new AbortController().signal,launch as any,3000);
    expect(sent.map(row=>row.id)).toEqual(['a'.repeat(64),'a'.repeat(64)]);
    expect(sent.map(row=>row.cursor)).toEqual([0,2]);expect(events.map(row=>row.seq)).toEqual([1,2,3,4]);
  });

  it('binds HTTP access to a per-turn secret and the authorized user/source',async()=>{
    await expect(startRemoteClaudeRelay(config,{userId:'other',sourceThreadId:'source-fixture',turnId:'turn'})).rejects.toThrow(/授权/);
    await expect(startRemoteClaudeRelay(config,{userId:'qa-user',sourceThreadId:'other',turnId:'turn'})).rejects.toThrow(/授权/);
    const submitted:any[]=[];
    const relay=vi.fn(async(_config,envelope,onEvent)=>{
      submitted.push(envelope);await onEvent({type:'headers',seq:1,status:200,headers:{'content-type':'application/json'}});
      await onEvent({type:'chunk',seq:2,data:Buffer.from('{"ok":true}').toString('base64')});await onEvent({type:'end',seq:3});
    });
    const gateway=await startRemoteClaudeRelay(config,{userId:'qa-user',sourceThreadId:'source-fixture',turnId:'turn-fixture'},relay as any);
    try{
      expect((await fetch(gateway.url+'/v1/messages',{method:'POST',body:'{}'})).status).toBe(403);
      const headers={'x-api-key':gateway.secret,'content-type':'application/json'};
      expect((await fetch(gateway.url+'/admin/login',{method:'POST',headers,body:'{}'})).status).toBe(403);
      expect((await fetch(gateway.url+'/v1/messages',{method:'POST',headers,body:JSON.stringify({model:'claude-sonnet-fixture'})})).status).toBe(403);
      const body=JSON.stringify({model:'claude-opus-fixture',messages:[{role:'user',content:'fixture'}]});
      for(let i=0;i<2;i++)expect(await (await fetch(gateway.url+'/v1/messages',{method:'POST',headers,body})).json()).toEqual({ok:true});
      expect(submitted).toHaveLength(2);expect(submitted[0].id).toBe(submitted[1].id);
      expect(JSON.stringify(submitted)).not.toContain(gateway.secret);
    }finally{gateway.close();}
  });
});
