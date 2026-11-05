import { useCallback, useEffect, useRef, useState } from "react";
import { readReclaudeUsage } from "./api";
import { reclaudeWindowActive, remainingTime, type ReclaudeUsageStatus } from "../shared/reclaudeUsage";
import { ReclaudeQuotaDetails } from "./reclaudeQuota";

export function useReclaudeUsage(scope: string) {
  const [snapshot,setSnapshot]=useState<{scope:string;data:ReclaudeUsageStatus}|null>(null);
  const scopeRef=useRef(scope),revision=useRef(0);
  scopeRef.current=scope;
  const receive=useCallback((data:ReclaudeUsageStatus)=>{
    revision.current++;
    setSnapshot({scope:scopeRef.current,data});
  },[]);
  useEffect(()=>{
    let disposed=false,inFlight=false;const controller=new AbortController();
    revision.current++;
    // This endpoint only reads existing server observations/local cache. It
    // cannot sync upstream usage. Share one reader across the entire page.
    const read=async()=>{
      if(document.visibilityState==="hidden"||inFlight)return;
      inFlight=true;const startedAtRevision=revision.current;
      try {
        const result=await readReclaudeUsage(controller.signal);
        if(!disposed&&startedAtRevision===revision.current)setSnapshot({scope,data:result.data});
      } catch { /* Keep the last observation; a read failure is not zero usage. */ }
      finally { inFlight=false; }
    };
    void read();const timer=window.setInterval(()=>void read(),30_000);
    document.addEventListener("visibilitychange",read);
    window.addEventListener("focus",read);
    window.addEventListener("reclaude-authenticated",read);
    return()=>{disposed=true;controller.abort();clearInterval(timer);document.removeEventListener("visibilitychange",read);window.removeEventListener("focus",read);window.removeEventListener("reclaude-authenticated",read);};
  },[scope]);
  return {status:snapshot?.scope===scope?snapshot.data:null,receive};
}
export function ReclaudeUsage({model,status}:{model:string;status:ReclaudeUsageStatus|null}) {
  const [expanded,setExpanded]=useState(false);
  if(!status)return null;
  const account=status.accounts.find(row=>row.orgId===model.split("@")[1]);
  const window=account?.windows.find(row=>row.kind==="seven_day"&&reclaudeWindowActive(row));
  return <aside className="reclaudeUsage" aria-label="ReClaude 用量">
    <button type="button" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>
      <span>ReClaude {account?.state==="disabled"?"已停用":window?`周用量 ${window.percent}%`:"周用量待更新"}</span>
      <span>Claude 本小时 {status.creations.used}/{status.creations.limit}</span>
    </button>
    {expanded?<div role="status">
      {account?<ReclaudeQuotaDetails account={account} cacheError={status.cacheError}/>:null}
      <p>全部 Claude 账号共用每小时 {status.creations.limit} 次额度，仅新建 Claude 会话、fork Claude 会话和迁入 Claude 计数。Codex 新建、fork 和迁入 Codex 不占此额度。{status.creations.remaining?`Claude 还剩 ${status.creations.remaining} 次。`:`Claude 额度还需等待 ${remainingTime(status.creations.retryAfterSeconds)}。`}</p>
    </div>:null}
  </aside>;
}
