import {EventEmitter} from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import {describe,it,expect} from "vitest";
import {AccountPoolBridge} from "./accountPoolBridge.js";
import {CodexBridge} from "./codexBridge.js";
import {ProjectStore} from "./db.js";
import {registerRoutes} from "./routes.js";

describe("paginated message editing",()=>{
  it("validates the observed last turn, refuses races and reverts a historical suffix without hydrating history or restarting",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"message-editing-"));
    const id="00000000-0000-4000-8000-000000000100";
    class Runtime extends EventEmitter {
      requests:{method:string;params:any}[]=[];
      latest="last";status="completed";queueReads=0;race=false;fail=false;stops=0;failBackup=false;backups=0;
      async start(){} stop(){this.stops++;} getPendingServerRequests(){return [];}
      async request(method:string,params:any={}){
        this.requests.push({method,params});
        if(method==="thread/read")return {thread:{id,historyMode:"paginated",status:{type:"idle"},turns:[]}};
        if(method==="thread/goal/get")return {goal:null};
        if(method==="thread/queue/list")return {data:this.race&&++this.queueReads>1?[{id:"newly-queued"}]:[],nextCursor:null};
        if(method==="thread/turns/list")return {data:[{id:this.latest,status:this.status}],nextCursor:null};
        if(method==="thread/resume")return {thread:{id,turns:[]}};
        if(method==="thread/fork"){
          if(this.failBackup)throw new Error("snapshot unavailable");
          return {thread:{id:`backup-${++this.backups}`,turns:[]}};
        }
        if(method==="thread/revert"){
          if(this.fail)throw new Error("revert failed before commit");
          this.latest="retained";return {thread:{id,turns:[]},turnsBackwardsCursor:"retained-cursor"};
        }
        return {};
      }
    }
    const native=new Runtime(),pool=new AccountPoolBridge({accounts:[{id:"fixture",label:"fixture",codexHome:root}],stateFile:"pool.json"},root,()=>native as unknown as CodexBridge);
    const store=new ProjectStore(path.join(root,"test.sqlite")),project=store.createProject({name:"isolated",rootPath:root});
    store.registerThreadOwner({threadId:id,userId:"admin",projectId:project.id,rootPath:root});
    const app=Fastify();registerRoutes(app,pool as unknown as CodexBridge,store,{backgroundIndexing:false});
    const edit=(payload:Record<string,unknown>)=>app.inject({method:"POST",url:`/api/projects/${project.id}/threads/${id}/edit-latest`,payload});
    try {
      expect((await edit({turnId:"old",allowHistoryRewrite:true})).statusCode).toBe(400);
      expect((await edit({turnId:"old"})).statusCode).toBe(409);
      expect((await edit({turnId:"old",expectedLatestTurnId:"stale",allowHistoryRewrite:true})).statusCode).toBe(409);
      native.status="running";
      expect((await edit({turnId:"last"})).statusCode).toBe(409);
      native.status="completed";native.queueReads=0;native.race=true;
      expect((await edit({turnId:"last"})).statusCode).toBe(409);
      expect(native.requests.filter(r=>r.method==="thread/revert")).toHaveLength(0);
      native.race=false;native.failBackup=true;
      expect((await edit({turnId:"last"})).statusCode).toBe(502);
      expect(native.requests.filter(r=>r.method==="thread/revert")).toHaveLength(0);
      native.failBackup=false;native.fail=true;
      expect((await edit({turnId:"last"})).statusCode).toBe(502);
      expect(native.latest).toBe("last");native.fail=false;
      const result=await edit({turnId:"old",expectedLatestTurnId:"last",allowHistoryRewrite:true});
      expect(result.statusCode,result.body).toBe(200);
      expect(result.json().data.thread.id).toBe(id);
      const backupId=result.json().data.recoveryThreadId;
      expect(store.userCanAccessThread(backupId,"admin",project.id)).toBe(true);
      expect(store.locallyArchivedThreadIds("admin",project.id).has(backupId)).toBe(true);
      expect(native.requests.filter(r=>r.method==="thread/archive").at(-1)?.params).toEqual({threadId:backupId});
      expect(native.requests.at(-1)).toEqual({method:"thread/revert",params:{threadId:id,beforeTurnId:"old"}});
      expect(native.requests.filter(r=>r.method==="thread/turns/list").every(r=>r.params.limit===1)).toBe(true);
      expect(native.requests.filter(r=>r.method==="thread/turns/list").every(r=>r.params.itemsView==="notLoaded")).toBe(true);
      expect(native.requests.filter(r=>r.method==="thread/fork").every(r=>r.params.excludeTurns===true)).toBe(true);
      expect(native.requests.filter(r=>r.method==="thread/read").every(r=>r.params.includeTurns===false)).toBe(true);
      expect(native.requests.filter(r=>r.method==="thread/resume").every(r=>r.params.excludeTurns===true)).toBe(true);
      expect(native.stops).toBe(0);
    }finally{await app.close();pool.stop();store.close();fs.rmSync(root,{recursive:true,force:true});}
  });
  const binary=path.resolve(process.cwd(),"../bin/codex-0.163.0/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex");
  it.skipIf(!fs.existsSync(binary))("uses a real isolated native runtime, preserves an archived backup and removes edited context before resend",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"message-edit-native-")),requests:Record<string,unknown>[]=[];
    const upstream=http.createServer(async(req,res)=>{
      let raw="";for await(const chunk of req)raw+=chunk;
      if(req.method!=="POST"||!req.url?.endsWith("/responses")){res.writeHead(404);res.end();return;}
      requests.push(JSON.parse(raw));const n=requests.length;
      res.writeHead(200,{"content-type":"text/event-stream"});
      const emit=(event:unknown)=>res.write(`data: ${JSON.stringify(event)}\n\n`);
      const response={id:`resp_${n}`,object:"response",model:"gpt-6.1-sol",status:"in_progress",output:[]};
      const item={id:`msg_${n}`,type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:`Answer ${n}`,annotations:[]}]};
      emit({type:"response.created",response});emit({type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}});
      emit({type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:`Answer ${n}`});
      emit({type:"response.output_item.done",output_index:0,item});
      emit({type:"response.completed",response:{...response,status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
    });
    await new Promise<void>(resolve=>upstream.listen(0,"127.0.0.1",resolve));
    const port=(upstream.address() as {port:number}).port;
    fs.writeFileSync(path.join(root,"auth.json"),JSON.stringify({OPENAI_API_KEY:"dummy-local-only"}),{mode:0o600});
    const runtimes:CodexBridge[]=[];
    const pool=new AccountPoolBridge({accounts:[{id:"isolated",label:"isolated",codexHome:root}],stateFile:"pool.json"},root,home=>{
      const runtime=new CodexBridge({command:binary,args:["app-server","--listen","stdio://","-c",`openai_base_url="http://127.0.0.1:${port}/v1"`,"-c",'model="gpt-6.1-sol"'],env:{PATH:process.env.PATH,HOME:root,CODEX_HOME:home,NO_PROXY:"127.0.0.1,localhost"}});runtimes.push(runtime);return runtime;
    });
    const store=new ProjectStore(path.join(root,"test.sqlite")),project=store.createProject({name:"native editing fixture",rootPath:root});
    const app=Fastify();registerRoutes(app,pool as unknown as CodexBridge,store,{backgroundIndexing:false});
    try{
      const created=await pool.startThreadOnAccount("isolated",{cwd:root,historyMode:"paginated",model:"gpt-6.1-sol",approvalPolicy:"never",sandbox:"read-only"}) as {thread:{id:string;historyMode:string}};
      const threadId=created.thread.id;expect(created.thread.historyMode).toBe("paginated");
      store.registerThreadOwner({threadId,userId:"admin",projectId:project.id,rootPath:root});
      const turn=async(text:string)=>{
        let listener:(message:any)=>void;
        const done=new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>{pool.off("notification",listener);reject(new Error("isolated turn timeout"));},10000);
          listener=message=>{if(message.method==="turn/completed"&&message.params?.threadId===threadId){clearTimeout(timer);pool.off("notification",listener);message.params.turn.status==="completed"?resolve():reject(new Error("isolated turn failed"));}};
          pool.on("notification",listener);
        });
        const result=await pool.request("turn/start",{threadId,input:[{type:"text",text}]}) as {turn:{id:string}};await done;return result.turn.id;
      };
      await turn("synthetic question 1");const target=await turn("synthetic question 2"),latest=await turn("synthetic question 3");
      const response=await app.inject({method:"POST",url:`/api/projects/${project.id}/threads/${threadId}/edit-latest`,payload:{turnId:target,expectedLatestTurnId:latest,allowHistoryRewrite:true}});
      expect(response.statusCode,response.body).toBe(200);
      const backup=response.json().data.recoveryThreadId;
      expect(store.locallyArchivedThreadIds("admin",project.id).has(backup)).toBe(true);
      await pool.request("thread/unarchive",{threadId:backup});
      const archived=await pool.request("thread/turns/list",{threadId:backup,itemsView:"notLoaded",limit:10}) as {data:unknown[]};
      expect(archived.data).toHaveLength(3);
      const remaining=await pool.request("thread/turns/list",{threadId,itemsView:"notLoaded",limit:10}) as {data:unknown[]};expect(remaining.data).toHaveLength(1);
      await turn("replacement question");
      const finalInput=JSON.stringify(requests.at(-1)?.input);
      expect(finalInput).toContain("synthetic question 1");expect(finalInput).toContain("replacement question");
      expect(finalInput).not.toContain("synthetic question 2");expect(finalInput).not.toContain("synthetic question 3");
      expect(requests).toHaveLength(4);
    }finally{await app.close();store.close();await Promise.all(runtimes.map(runtime=>runtime.stopAndWait()));pool.stop();await new Promise<void>(resolve=>upstream.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
  },30000);
});
