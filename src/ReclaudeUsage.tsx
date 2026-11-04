import { useEffect, useState } from "react";
import { readReclaudeUsage } from "./api";
import { remainingTime, type ReclaudeUsageStatus } from "../shared/reclaudeUsage";

export function useReclaudeUsage(enabled: boolean) {
  const [status,setStatus]=useState<ReclaudeUsageStatus|null>(null);
  useEffect(()=>{
    if(!enabled)return;
    let disposed=false;const controller=new AbortController();
    const read=()=>{if(document.visibilityState!=="hidden")void readReclaudeUsage(controller.signal).then(result=>{if(!disposed)setStatus(result.data);}).catch(()=>{});};
    read();const timer=window.setInterval(read,30_000);
    document.addEventListener("visibilitychange",read);
    return()=>{disposed=true;controller.abort();clearInterval(timer);document.removeEventListener("visibilitychange",read);};
  },[enabled]);
  return status;
}
export function ReclaudeUsage({model}:{model:string}) {
  const status=useReclaudeUsage(true),[expanded,setExpanded]=useState(false);
  if(!status)return null;
  const account=status.accounts.find(row=>row.orgId===model.split("@")[1]);
  const window=account?.windows.find(row=>row.kind==="seven_day");
  return <aside className="reclaudeUsage" aria-label="ReClaude 用量">
    <button type="button" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>
      <span>ReClaude {account?.state==="disabled"?"已停用":window?`周用量 ${window.percent}%`:"周用量待更新"}</span>
      <span>Claude 本小时 {status.creations.used}/{status.creations.limit}</span>
    </button>
    {expanded?<div role="status">
      <p>{account?.message}</p>
      <p>全部 Claude 账号共用每小时 {status.creations.limit} 次额度，仅新建 Claude 会话、fork Claude 会话和迁入 Claude 计数。Codex 新建、fork 和迁入 Codex 不占此额度。{status.creations.remaining?`Claude 还剩 ${status.creations.remaining} 次。`:`Claude 额度还需等待 ${remainingTime(status.creations.retryAfterSeconds)}。`}</p>
      {account?.windows.filter(w=>w.kind!=="seven_day").map(w=><p key={w.kind}>{w.kind==="five_hour"?"五小时":w.kind.includes("sonnet")?"Sonnet 周用量":w.kind.includes("opus")?"Opus 周用量":"模型周用量"}：{w.percent}%</p>)}
      {window?<p>数据时间：{new Date(window.observedAt).toLocaleString()}。{window.resetsAt?`重置时间：${new Date(window.resetsAt).toLocaleString()}。`:""}</p>:null}
      {status.cacheError?<p>{status.cacheError}</p>:null}
    </div>:null}
  </aside>;
}
