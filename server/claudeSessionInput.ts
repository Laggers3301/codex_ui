import type {SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import type {ConversationTask} from '../shared/conversationTasks.js';
// The runtime SDK is loaded from integrations/claude-session-tools. Older
// backend compile-time declarations do not yet describe its priority field.
export type ClaudeNativeUserMessage=Omit<SDKUserMessage,'uuid'>&{uuid?:string;priority?:'now'|'next'|'later'};

/** Keep streaming input open for native background notifications and steering. */
export class ClaudeSessionInput implements AsyncIterable<ClaudeNativeUserMessage>{
  private entries:ClaudeNativeUserMessage[]=[];
  private waiting:((message:ClaudeNativeUserMessage|null)=>void)|null=null;
  private closed=false;
  push(message:ClaudeNativeUserMessage){
    if(this.closed)throw Error('Claude 输入通道已关闭。');
    if(this.waiting){const resolve=this.waiting;this.waiting=null;resolve(message);}
    else{if(this.entries.length>=16)throw Error('Claude 待投递消息过多，请等待当前消息受理。');this.entries.push(message);}
  }
  steer(content:any[],id:string){
    // Native "next" queues the input at a processing boundary. "now" aborts
    // an active sample and must not be used for ordinary direction changes.
    this.push({type:'user',uuid:id,priority:'next',message:{role:'user',content},parent_tool_use_id:null,session_id:''});
  }
  close(){this.closed=true;this.entries=[];this.waiting?.(null);this.waiting=null;}
  async *[Symbol.asyncIterator](){
    while(!this.closed){const message=this.entries.shift()??await new Promise<ClaudeNativeUserMessage|null>(resolve=>{this.waiting=resolve;});if(!message)return;yield message;}
  }
}

export interface ClaudeNativeTask extends Omit<ConversationTask,'kind'> {runId?:string;toolUseId?:string;wasBackground?:boolean;kind?:ConversationTask['kind'];}
export class ClaudeTaskLedger{
  readonly tasks=new Map<string,ClaudeNativeTask>();
  private ambient=new Set<string>();
  get pending(){return [...this.tasks.values()].filter(t=>t.background&&t.status==='running');}
  update(message:any){
    const before=JSON.stringify(this.snapshot());
    const put=(id:unknown,patch:Partial<ClaudeNativeTask>)=>{
      if(typeof id!=='string'||!id||id.length>256)return;
      const old=this.tasks.get(id);
      if(old?.runId&&patch.runId&&patch.runId<old.runId)return;
      const newRun=!!old?.runId&&!!patch.runId&&patch.runId>old.runId;
      const defined=Object.fromEntries(Object.entries(patch).filter(([,value])=>value!==undefined));
      const next:ClaudeNativeTask={id,description:'',status:'running',background:true,...(!newRun?old:{}),...defined};
      if(next.background)next.wasBackground=true;
      if(JSON.stringify({...next,updatedAt:undefined})!==JSON.stringify({...old,updatedAt:undefined}))next.updatedAt=Date.now();
      this.tasks.set(id,next);
    };
    const text=(value:unknown,limit:number)=>typeof value==='string'?value.slice(0,limit):undefined;
    const metadata=(value:any):Partial<ClaudeNativeTask>=>{
      const usage=value.usage;
      const counter=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:0;
      return {description:text(value.description,500),parentTaskId:text(value.parent_task_id,256),subagentType:text(value.subagent_type,120),
        summary:text(value.summary,4096),lastToolName:text(value.last_tool_name,120),
        ...(usage?{usage:{totalTokens:counter(usage.total_tokens),toolUses:counter(usage.tool_uses),durationMs:counter(usage.duration_ms)}}:{})};
    };
    const kind=(value:any):ConversationTask['kind']=>value.task_type==='local_agent'||value.subagent_type?'agent':value.task_type==='local_bash'?'shell':'unknown';
    if(message.type==='system'&&message.subtype==='task_started'&&typeof message.task_id==='string'){
      if(message.ambient)this.ambient.add(message.task_id);else this.ambient.delete(message.task_id);
    }
    if(message.type==='system'&&this.ambient.has(message.task_id))return false;
    if(message.type==='system'&&!message.ambient){
      const runId=typeof message.run_id==='string'?message.run_id:undefined;
      if(message.subtype==='task_started')put(message.task_id,{...metadata(message),runId,toolUseId:message.tool_use_id,kind:kind(message),background:message.is_backgrounded!==false});
      const previous=this.tasks.get(message.task_id);
      if(message.subtype==='task_progress'&&(!previous||previous.status==='running'||!!runId&&!!previous.runId&&runId>previous.runId))put(message.task_id,{...metadata(message),runId,toolUseId:message.tool_use_id,
        ...(message.subagent_type?{kind:'agent'}:{}),background:previous&&(!runId||!previous.runId||runId===previous.runId)?previous.background:false});
      if(message.subtype==='task_updated'&&message.patch?.is_backgrounded===true)put(message.task_id,{runId,background:true});
      if(message.subtype==='task_notification'&&['completed','failed','stopped'].includes(message.status))put(message.task_id,{...metadata(message),runId,status:message.status});
      if(message.subtype==='background_tasks_changed'&&Array.isArray(message.tasks)){
        const live=new Set<string>();
        for(const task of message.tasks){
          if(task.ambient){this.ambient.add(task.task_id);continue;}
          this.ambient.delete(task.task_id);live.add(task.task_id);put(task.task_id,{...metadata(task),runId:task.run_id,kind:kind(task),background:true});
        }
        // Absence means no longer live, not proof of a successful execution.
        for(const task of this.pending)if(!live.has(task.id)){task.background=false;task.status='unknown';}
      }
    }
    const result=message.type==='user'?message.tool_use_result:null;
    if(result?.isAsync===true&&result.status==='async_launched'){
      const call=message.message?.content?.find?.((block:any)=>block.type==='tool_result');
      put(result.agentId,{background:true,kind:'agent',toolUseId:call?.tool_use_id,description:String(result.description??'').slice(0,500)});
    }
    if(result?.status==='completed'&&typeof result.agentId==='string')put(result.agentId,{status:'completed',background:false,kind:'agent'});
    return before!==JSON.stringify(this.snapshot());
  }
  stop(){for(const task of this.pending)task.status='interrupted';}
  snapshot(){return [...this.tasks.values()].map(task=>({...task}));}
}
