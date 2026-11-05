import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {X} from "./PanelIcons";
import type {CodexAccountPool,ModelProfile} from "./types";
import {isReclaudeModel,modelIsAvailable} from "../shared/agentRuntime";
import {runtimeModelLabel} from "./runtimeModelLabel";
import {BranchChoice} from "./BranchChoice";
import {effortDescending} from "./effortOrder";
import type {ReasoningEffort} from "./types";
import "./taskNotificationSettings.css";
import "./runtimeMigration.css";

export interface BranchTarget {targetAccountId?:string;model?:string;operationId?:string;reasoningEffort?:ReasoningEffort}
export function BranchTargetDialog(props:{sourceModel:string;sourceEffort?:ReasoningEffort;pool:CodexAccountPool|null;profiles:ModelProfile[];onClose():void;onConfirm(target:BranchTarget):Promise<boolean>}){
  const [destination,setDestination]=useState("auto"),[model,setModel]=useState(props.sourceModel),[pending,setPending]=useState(false),[error,setError]=useState(""),[closing,setClosing]=useState(false);
  const operation=useRef(crypto.randomUUID());
  const [effort,setEffort]=useState(props.sourceEffort??"medium");
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  const claude=destination==="claude"||(destination==="auto"&&isReclaudeModel(props.sourceModel));
  const models=props.profiles.filter(p=>isReclaudeModel(p.model)===claude&&(claude||p.model.startsWith("gpt-"))).filter((p,i,a)=>a.findIndex(q=>q.model===p.model)===i);
  const cross=destination!=="auto"&&isReclaudeModel(props.sourceModel)!==claude;
  const efforts=[...new Set(props.profiles.filter(p=>p.model===model&&modelIsAvailable(p)).map(p=>p.effort))].sort(effortDescending);
  const selectedEffort=efforts.includes(effort)?effort:efforts[0];
  const showEffort=!claude||props.profiles.some(p=>p.model===model&&p.supportedEffortLevels?.length);
  function close(){if(pending||closing)return;setClosing(true);timer.current=setTimeout(props.onClose,220);}
  function choose(value:string){setDestination(value);setError("");operation.current=crypto.randomUUID();const available=props.profiles.filter(p=>modelIsAvailable(p)&&(value==="claude"?isReclaudeModel(p.model):p.model.startsWith("gpt-")));setModel(available.find(p=>p.model===props.sourceModel)?.model??available[0]?.model??"");}
  async function submit(){if(pending)return;setPending(true);setError("");try{const level=showEffort&&selectedEffort?{reasoningEffort:selectedEffort}:{};const ok=await props.onConfirm(destination==="auto"?level:{...(claude?{}:{targetAccountId:destination}),model,operationId:operation.current,...level});if(ok){setClosing(true);timer.current=setTimeout(props.onClose,220);}else setError("分支未完成，请查看会话中的错误提示后重试。");}catch(caught){setError(caught instanceof Error?caught.message:String(caught));}finally{setPending(false);}}
  const content=<div className={`taskNotificationScrim branchTargetScrim${closing?" uiClosing":""}`} onMouseDown={e=>{if(e.target===e.currentTarget)close();}} onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close();}}}>
    <section className="taskNotificationDialog branchTargetDialog" role="dialog" aria-modal="true" aria-label="选择分支目标">
      <header><h2>创建分支</h2><button type="button" className="taskNotificationIcon" aria-label="关闭" disabled={pending} onClick={close}><X size={16}/></button></header>
      <div className="branchTargetBody">
        <BranchChoice label="目标账号" value={destination} disabled={pending} onChange={value=>{choose(value);if(value==="auto")setModel(props.sourceModel);}} options={[
          {value:"auto",label:"自动选择（保留原模型）"},
          ...(props.pool?.accounts??[]).filter(a=>a.kind!=="api-provider").sort((a,b)=>a.id.localeCompare(b.id,"en",{numeric:true})).map(a=>({value:a.id,label:a.label})),
          {value:"claude",label:"ReClaude",disabled:!props.profiles.some(p=>isReclaudeModel(p.model)&&modelIsAvailable(p))}
        ]}/>
        {destination!=="auto"?<BranchChoice label="目标模型" value={model} disabled={pending} onChange={value=>{setModel(value);operation.current=crypto.randomUUID();}} options={models.map(p=>({value:p.model,label:runtimeModelLabel(p).replace(/\s+(?:low|medium|high|xhigh|max|ultra)$/,""),disabled:!modelIsAvailable(p)}))}/>:null}
        {showEffort&&efforts.length?<BranchChoice label="推理级别" value={selectedEffort} disabled={pending} onChange={value=>{setEffort(value as ReasoningEffort);operation.current=crypto.randomUUID();}} options={efforts.map(value=>({value,label:value}))}/>:null}
        <p className="branchTargetNote">{cross?"保留此回答及之前的对话与工具记录，不重放工具。":"保留此回答及之前的历史，原会话不变。"}{claude?" 计入 ReClaude 会话创建限额。":""}</p>
        {error?<p className="runtimeMigrationError" role="alert">{error}</p>:null}
      </div>
      <footer><button type="button" className="taskNotificationTest" disabled={pending||closing||(destination!=="auto"&&!models.some(p=>p.model===model&&modelIsAvailable(p)))} onClick={()=>void submit()}>{pending?"正在创建…":"创建并打开"}</button></footer>
    </section>
  </div>;
  return typeof document==="undefined"?content:createPortal(content,document.body);
}
