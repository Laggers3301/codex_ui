import { useEffect,useRef,useState } from "react";
import { X } from "lucide-react";
import type { ModelProfile } from "./types";
import { migrateThreadRuntime, type RuntimeMigrationResult } from "./api";
import { isReclaudeModel, modelIsAvailable } from "../shared/agentRuntime";
import { remainingTime, type ReclaudeUsageStatus } from "../shared/reclaudeUsage";
import "./runtimeMigration.css";
import {BranchChoice} from "./BranchChoice";
import {runtimeModelLabel} from "./runtimeModelLabel";

export function RuntimeMigrationDialog(props:{threadId:string;projectId:string;name:string;sourceClaude:boolean;profiles:ModelProfile[];usageStatus:ReclaudeUsageStatus|null;initialModel?:string;onClose():void;onComplete(result:RuntimeMigrationResult):Promise<void>}) {
  const targets=props.profiles.filter(p=>isReclaudeModel(p.model)!==props.sourceClaude)
    .filter((p,index,array)=>array.findIndex(other=>other.model===p.model)===index);
  const [model,setModel]=useState(props.initialModel??targets.find(modelIsAvailable)?.model??"");
  const [operationId,setOperationId]=useState(()=>crypto.randomUUID());
  const [pending,setPending]=useState(false),[error,setError]=useState("");
  const [closing,setClosing]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  function close(){if(pending||closing)return;setClosing(true);timer.current=setTimeout(props.onClose,220);}
  const status=props.usageStatus;
  async function migrate(){
    if(pending)return;setPending(true);setError("");
    try{const result=await migrateThreadRuntime(props.projectId,props.threadId,{operationId,model});setClosing(true);await new Promise(resolve=>setTimeout(resolve,220));await props.onComplete(result.data);}
    catch(caught){setError(caught instanceof Error?caught.message:String(caught));}
    finally{setPending(false);}
  }
  return <div className={`workspaceFeatureScrim${closing?" uiClosing":""}`} role="presentation" onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close();}}} onMouseDown={event=>{if(event.target===event.currentTarget)close();}}>
    <section className="workspaceFeatureDialog runtimeMigrationDialog uiGlassSurface" role="dialog" aria-modal="true" aria-label="迁移会话">
      <header><strong>迁移会话</strong><button type="button" disabled={pending} aria-label="关闭" onClick={close}><X size={17}/></button></header>
      <div className="workspaceFeatureBody">
        <p>将「{props.name||"当前会话"}」迁移到 {props.sourceClaude?"Codex":"ReClaude"} 新会话，原会话和完整源记录保留。</p>
        <BranchChoice label="目标模型" value={model} disabled={pending} onChange={value=>{setModel(value);setOperationId(crypto.randomUUID());setError("");}} options={targets.map(profile=>({value:profile.model,label:runtimeModelLabel(profile)+(profile.availability==="disabled"?"（额度停用）":""),disabled:!modelIsAvailable(profile)}))}/>
        <p>对话文字和工具记录会导入新会话；工具不会重新执行。附件原始数据和无法跨引擎复用的内部状态保存在源记录中。</p>
        <p role="status">{props.sourceClaude?"迁入 Codex 不占用 Claude 会话额度，也不受 Claude 每小时 5 次限额限制。":<>迁入 Claude 占用一个名额，全部 Claude 账号共用每小时 5 次额度。{status?status.creations.remaining?`Claude 当前剩余 ${status.creations.remaining} 次。`:`Claude 额度还需等待 ${remainingTime(status.creations.retryAfterSeconds)}。`:""}</>}</p>
        {error?<p className="runtimeMigrationError" role="alert">{error}</p>:null}
        <button type="button" className="primaryButton" disabled={pending||!model||!targets.some(p=>p.model===model&&modelIsAvailable(p))} onClick={()=>void migrate()}>{pending?"正在保存历史并迁移…":"迁移并打开新会话"}</button>
      </div>
    </section>
  </div>;
}
