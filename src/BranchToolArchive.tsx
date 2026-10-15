import {useEffect,useState} from "react";
import {X} from "./PanelIcons";
type Summary={threadId:string;archivedRecords:number;originalBranchBytes:number;branchBytes:number;archiveBytes:number};
const shownNotices=new Set<string>();
const noticeKey=(userId:string,threadId:string)=>`codex-tool-archive-shown:${encodeURIComponent(userId)}:${threadId}`;
function wasShown(key:string){
  if(shownNotices.has(key))return true;
  try{return localStorage.getItem(key)==="1";}catch{return false;}
}
export function BranchToolArchive({userId,projectId,threadId}:{userId:string;projectId?:string;threadId?:string}){
  const [state,setState]=useState<{scope:string;summary:Summary}|null>(null),[closing,setClosing]=useState(false);
  const scope=`${userId}:${projectId}:${threadId}`;
  useEffect(()=>{
    setState(null);setClosing(false);
    if(!projectId||!threadId||wasShown(noticeKey(userId,threadId)))return;
    const abort=new AbortController();
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}/tool-output-archive`,{credentials:"same-origin",cache:"no-store",signal:abort.signal}).then(async response=>{
      if(!response.ok)return;
      const data=await response.json();if(!abort.signal.aborted&&data.data?.threadId===threadId)setState({scope,summary:data.data});
    }).catch(()=>{});
    return()=>abort.abort();
  },[scope,projectId,threadId]);
  // Mark after the notice actually renders, not while its request is pending.
  // Closing is optional: refresh/re-entry must never repeat the notification.
  useEffect(()=>{
    if(!state||state.scope!==scope||!threadId)return;
    const key=noticeKey(userId,threadId);shownNotices.add(key);
    try{localStorage.setItem(key,"1");}catch{}
  },[state,scope,userId,threadId]);
  useEffect(()=>{if(!closing)return;const timer=setTimeout(()=>setState(null),240);return()=>clearTimeout(timer);},[closing]);
  if(!state||state.scope!==scope)return null;
  const m=state.summary;
  return <div className={`branchToolArchive uiGlassSurface${closing?" closing":""}`} role="status" inert={closing}>
    <span>已归档 {m.archivedRecords.toLocaleString()} 条较早的超长工具结果，原会话不变。</span>
    <a href={`/api/projects/${encodeURIComponent(projectId!)}/threads/${encodeURIComponent(threadId!)}/tool-output-archive?download=1`}>完整工具记录附件</a>
    <button type="button" aria-label="收起工具记录附件提示" onClick={()=>setClosing(true)}><X size={14}/></button>
  </div>;
}
