import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AccountPoolBridge } from "./accountPoolBridge.js";

const remoteConfig = z.object({ is_enabled:z.boolean(), prompt:z.string().max(12000), prompt_version:z.string().max(100), prediction_reasoning_effort:z.string().nullable(), unsupported_models:z.array(z.string()).optional() });
export const predictionSchema={type:"object",properties:{suggestion:{type:["string","null"]}},required:["suggestion"],additionalProperties:false};
export const predictionOverrides:Record<string,unknown>={
  "features.shell_tool":false,"features.unified_exec":false,"features.shell_snapshot":false,
  "features.apply_patch_freeform":false,"features.js_repl":false,"features.js_repl_tools_only":false,
  "features.code_mode":false,"features.code_mode_only":false,"features.multi_agent":false,
  "features.multi_agent_v2":false,"features.enable_fanout":false,"features.apps":false,
  "features.plugins":false,"features.image_generation":false,"features.request_permissions_tool":false,
  "features.default_mode_request_user_input":false,"features.memories":false,
  "features.reasoning_effort_override":true,"tools.view_image":false,web_search:"disabled",
};
type Result={text:string|null;sourceTurnId:string;eligible:boolean;reason?:string};
type Job={abort:AbortController;promise:Promise<Result>;accountId:string};
export function parsePrediction(text:string):string|null {
  try { const value=z.object({suggestion:z.string().trim().max(1000).nullable()}).strict().parse(JSON.parse(text));return value.suggestion || null; }catch{return null;}
}
export class ComposerPredictions {
  private configs=new Map<string,{expires:number,value:z.infer<typeof remoteConfig>|null}>();
  private jobs=new Map<string,Job>();
  private results=new Map<string,{expires:number,result:Result}>();
  private lastAttempts=new Map<string,number>();
  constructor(private pool:AccountPoolBridge,private fetcher:typeof fetch=fetch){}
  async config(accountId:string) {
    const cached=this.configs.get(accountId);if(cached&&cached.expires>Date.now())return cached.value;
    const target=this.pool.modelCatalogTargets().find(t=>t.id===accountId);if(!target)return null;
    let value:z.infer<typeof remoteConfig>|null=null;
    try {
      const file=path.join(target.codexHome,"auth.json");if(fs.statSync(file).size>128*1024)throw new Error("auth file too large");
      const auth=JSON.parse(fs.readFileSync(file,"utf8")),token=auth.tokens?.access_token,account=auth.tokens?.account_id;
      if(typeof token!=="string"||typeof account!=="string"||/[\r\n]/.test(account))throw new Error("auth unavailable");
      const response=await this.fetcher("https://chatgpt.com/backend-api/wham/predictions/config",{
        headers:{authorization:`Bearer ${token}`,"chatgpt-account-id":account,"user-agent":"Codex-Web-Console/ComposerPredictions"},
        redirect:"error",signal:AbortSignal.timeout(12000),
      });
      if(response.ok)value=remoteConfig.parse(await response.json());
    }catch { /* Never rotate credentials or fall back to another account. */ }
    this.configs.set(accountId,{expires:Date.now()+(value?300000:60000),value});return value;
  }
  async request(userId:string,threadId:string,sourceTurnId:string,signal:AbortSignal,variant=""):Promise<Result> {
    const key=`${userId}:${threadId}:${sourceTurnId}:${variant}`;
    const empty=(reason:string):Result=>({text:null,sourceTurnId,eligible:false,reason});
    const cached=this.results.get(key);if(cached&&cached.expires>Date.now())return cached.result;
    if(signal.aborted)return empty("cancelled");
    if(this.jobs.has(key))return empty("already-requested");
    for(const [other,job] of this.jobs)if(other.startsWith(`${userId}:${threadId}:`))job.abort.abort();
    const account=await this.pool.resolveThreadAccount(threadId);
    if(!this.pool.modelCatalogTargets().some(t=>t.id===account.id))return empty("unsupported-provider");
    const throttle=`${userId}:${account.id}`;
    if(Date.now()-(this.lastAttempts.get(throttle)??0)<15000)return empty("rate-limited");
    if([...this.jobs.keys()].some(k=>k.startsWith(`${userId}:`)))return empty("prediction-busy");
    const config=await this.config(account.id);
    if(!config?.is_enabled)return empty("not-enabled");
    if(signal.aborted)return empty("cancelled");
    // Recheck after network awaits. One background prediction per account,
    // never a queue of speculative model requests behind users' real work.
    if(this.jobs.has(key)||[...this.jobs.values()].some(j=>j.accountId===account.id))return empty("prediction-busy");
    if(Date.now()-(this.lastAttempts.get(throttle)??0)<15000)return empty("rate-limited");
    const abort=new AbortController(),relay=()=>abort.abort();signal.addEventListener("abort",relay,{once:true});
    this.lastAttempts.set(throttle,Date.now());
    const promise=this.generate(threadId,sourceTurnId,config,abort).catch(()=>empty(abort.signal.aborted?"cancelled":"unavailable"));
    this.jobs.set(key,{abort,promise,accountId:account.id});
    while(this.lastAttempts.size>2000)this.lastAttempts.delete(this.lastAttempts.keys().next().value!);
    try {
      const result=await promise;
      if(!abort.signal.aborted){this.results.set(key,{expires:Date.now()+600000,result});while(this.results.size>200)this.results.delete(this.results.keys().next().value!);}
      return result;
    }finally{signal.removeEventListener("abort",relay);this.jobs.delete(key);}
  }
  private async generate(source:string,sourceTurnId:string,config:z.infer<typeof remoteConfig>,abort:AbortController):Promise<Result> {
    const rpc=(method:string,params:unknown)=>this.pool.requestOnThreadAccount(source,method,params,10000) as Promise<any>;
    const empty=(reason:string):Result=>({text:null,sourceTurnId,eligible:false,reason});
    const loaded=await rpc("thread/loaded/list",{});
    if(!Array.isArray(loaded.data)||!loaded.data.includes(source))return empty("not-loaded");
    const metadata=await rpc("thread/resume",{threadId:source,excludeTurns:true});
    if(metadata.thread?.status?.type!=="idle")return empty("source-busy");
    if(metadata.modelProvider!=="openai"||config.unsupported_models?.includes(metadata.model))return empty("unsupported-model");
    if(abort.signal.aborted)return empty("cancelled");
    const settings=await rpc("config/read",{includeLayers:false});
    const overrides:Record<string,unknown>={...predictionOverrides,model_reasoning_effort:config.prediction_reasoning_effort||metadata.reasoningEffort};
    for(const name of Object.keys(settings.config?.mcp_servers??{}))overrides[`mcp_servers.${name}.enabled`]=false;
    let predictionId:string|null=null,turnId:string|null=null,text="",detach=()=>{};
    const interrupt=()=>{if(predictionId&&turnId)void rpc("turn/interrupt",{threadId:predictionId,turnId}).catch(()=>{});};
    const timeout=setTimeout(()=>abort.abort(),30000);
    const parentListener=(event:any)=>{if(event.method==="turn/started"&&event.params?.threadId===source)abort.abort();};
    this.pool.on("notification",parentListener);
    abort.signal.addEventListener("abort",interrupt);
    try {
      const fork=await rpc("thread/fork",{threadId:source,model:metadata.model,modelProvider:"openai",cwd:metadata.thread?.cwd,
        serviceTier:metadata.serviceTier,permissions:":read-only",approvalPolicy:"never",runtimeWorkspaceRoots:[],
        ephemeral:true,excludeTurns:true,threadSource:"composer_predictions",deferGoalContinuation:false,config:overrides});
      predictionId=fork.thread?.id;
      if(!predictionId)throw new Error("No ephemeral prediction thread");
      if(abort.signal.aborted)return empty("cancelled");
      const completion=new Promise<void>((resolve,reject)=>{
        const onAbort=()=>reject(new Error("Prediction cancelled"));
        const listener=(event:any)=>{
          const p=event.params;if(p?.threadId!==predictionId)return;
          if(event.method==="turn/started")turnId=p.turn.id;
          if(event.method==="item/agentMessage/delta")text+=p.delta??"";
          if(event.method==="item/completed"&&p.item?.type==="agentMessage")text=p.item.text??text;
          if(event.method==="item/started"&&p.item?.type&&!['userMessage','agentMessage','reasoning'].includes(p.item.type)){interrupt();reject(new Error("Unexpected prediction tool"));}
          if(event.method==="turn/completed")p.turn.status==="completed"?resolve():reject(new Error("Prediction failed"));
        };
        this.pool.on("notification",listener);abort.signal.addEventListener("abort",onAbort,{once:true});
        detach=()=>{this.pool.removeListener("notification",listener);abort.signal.removeEventListener("abort",onAbort);};
      });
      // Attach rejection handling before turn/start: it can emit before its ACK.
      const waiting=completion.then(()=>({ok:true}),()=>({ok:false}));
      const started=await rpc("turn/start",{threadId:predictionId,turnTrigger:"composer_predictions",model:metadata.model,
        effort:config.prediction_reasoning_effort||metadata.reasoningEffort,permissions:":read-only",runtimeWorkspaceRoots:[],approvalPolicy:"never",
        input:[{type:"text",text:`${config.prompt}\n\nReturn only JSON matching this schema: ${JSON.stringify(predictionSchema)}.`,text_elements:[]}],outputSchema:predictionSchema});
      turnId??=started.turn?.id;
      if(abort.signal.aborted)interrupt();
      const completed=await waiting;if(!completed.ok)return empty("unavailable");
      return {text:parsePrediction(text),sourceTurnId,eligible:true};
    }finally {
      clearTimeout(timeout);detach();this.pool.removeListener("notification",parentListener);abort.signal.removeEventListener("abort",interrupt);
      if(predictionId)await rpc("thread/unsubscribe",{threadId:predictionId}).catch(()=>{});
    }
  }
}
