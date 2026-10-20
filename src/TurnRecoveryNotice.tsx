import { useEffect, useState } from "react";
import {createPortal} from 'react-dom';
import {X} from './PanelIcons';
import "./TurnRecoveryNotice.css";

export interface TurnRecoveryView {
  threadId: string;
  error: null | { code: string; message: string; originalMessage: string; retryable: boolean; at: string };
  job: null | { status: "waiting" | "running" | "exhausted"; attempts: number; maxAttempts: number; nextRetryAt: number | null };
}

export function historicalRecovery(threadId: string, turn?: { status: unknown; [key: string]: unknown }): TurnRecoveryView | undefined {
  if (turn?.status !== "failed" || !turn.error || typeof turn.error !== "object") return;
  const error = turn.error as Record<string, unknown>;
  if (typeof error.message !== "string") return;
  return { threadId, job: null, error: { code: typeof error.code === "string" ? error.code : String(error.codexErrorInfo ?? "request_failed"),
    message: error.message, originalMessage: typeof error.originalMessage === "string" ? error.originalMessage : error.message,
    retryable: false, at: typeof error.at === "string" ? error.at : typeof turn.completedAt==='number'?new Date(turn.completedAt*1000).toISOString():"" } };
}

export function isFreshRecoveryNotice(state:TurnRecoveryView|undefined,now=Date.now()) {
  if(state?.job?.status==='waiting'||state?.job?.status==='running')return true;
  const at=Date.parse(state?.error?.at??'');return Boolean(state?.error&&Number.isFinite(at)&&now-at<120_000);
}

export function recoveryViewportBounds(width:number,height:number,viewport?:{offsetLeft:number;offsetTop:number;width:number;height:number}) {
  return {left:viewport?.offsetLeft??0,top:viewport?.offsetTop??0,width:viewport?.width??width,height:viewport?.height??height};
}

export function TurnRecoveryNotice({ state, userId,turnId,onSelectModel, onAction }: { state?: TurnRecoveryView; userId: string;turnId?:string;onSelectModel?:()=>void; onAction: (action: "now" | "cancel" | "dismiss") => void }) {
  const [now, setNow] = useState(Date.now());
  const [visible,setVisible]=useState(false),[present,setPresent]=useState(false),[detailsOpen,setDetailsOpen]=useState(false),[hovered,setHovered]=useState(false);
  const [displayed,setDisplayed]=useState(state);
  const [position,setPosition]=useState(()=>recoveryViewportBounds(innerWidth,innerHeight,window.visualViewport??undefined));
  const key=`codex-recovery-seen:${userId}:${state?.threadId??''}:${turnId??state?.error?.at??''}:${state?.error?.code??''}`;
  const remember=()=>{try{sessionStorage.setItem(key,'1');}catch{}};
  const close=()=>{remember();setVisible(false);};
  useEffect(()=>{
    setDetailsOpen(false);setHovered(false);
    let seen=false;try{seen=sessionStorage.getItem(key)==='1';}catch{}
    const show=!seen&&isFreshRecoveryNotice(state);
    setVisible(show);if(show){setPresent(true);setDisplayed(state);}
  },[key]);
  useEffect(()=>{
    if(!state?.error&&!state?.job)setVisible(false);else setDisplayed(state);
  },[state?.error,state?.job]);
  useEffect(()=>{
    if(!visible||detailsOpen||hovered)return;
    const timer=window.setTimeout(()=>{remember();setVisible(false);},8000);
    return()=>window.clearTimeout(timer);
  },[visible,detailsOpen,hovered,key]);
  useEffect(()=>{
    if(visible||!present)return;
    const timer=window.setTimeout(()=>setPresent(false),260);return()=>window.clearTimeout(timer);
  },[visible,present]);
  useEffect(()=>{
    if(!present)return;
    const measure=()=>{
      const next=recoveryViewportBounds(innerWidth,innerHeight,window.visualViewport??undefined);
      setPosition(previous=>Object.keys(next).every(k=>previous[k as keyof typeof next]===next[k as keyof typeof next])?previous:next);
    };
    measure();window.addEventListener('resize',measure);window.visualViewport?.addEventListener('resize',measure);window.visualViewport?.addEventListener('scroll',measure);
    return()=>{window.removeEventListener('resize',measure);window.visualViewport?.removeEventListener('resize',measure);window.visualViewport?.removeEventListener('scroll',measure);};
  },[present]);
  useEffect(() => {
    if (state?.job?.status !== "waiting") return;
    setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [state?.job?.status, state?.job?.nextRetryAt]);
  if (!present||(!displayed?.error && !displayed?.job)) return null;
  const view=displayed,job = view.job;
  return createPortal(<div className={`turnRecoveryDock${visible?'':' uiClosing'}`} style={position} aria-hidden={!visible} inert={!visible}>
    <div className="turnRecoveryNotice" role="status" aria-label="本轮模型状态"
      onMouseEnter={()=>{if(matchMedia('(hover: hover)').matches)setHovered(true);}} onMouseLeave={()=>setHovered(false)}>
    <div className="turnRecoveryHeading"><strong>{job?.status==='running'?'正在重试本轮请求。':view.error?.code==='model_overloaded'?'模型繁忙，可切换模型或稍后重试。':view.error?.message ?? "正在继续原任务。"}</strong><button type="button" aria-label="关闭模型状态提示" onClick={()=>{close();if(!job||job.status==='exhausted')onAction('dismiss');}}><X size={16}/></button></div>
    {job?.status === "waiting" ? <p>等待重试 · {Math.max(0, Math.ceil(((job.nextRetryAt ?? now) - now) / 1000))} 秒 · 第 {job.attempts + 1}/{job.maxAttempts} 次</p> : null}
    {job?.status === "running" ? <p>正在进行第 {job.attempts} 次自动续接，沿用当前会话和模型。</p> : null}
    {job?.status === "exhausted" ? <p>已达到 {job.maxAttempts} 次重试上限，请稍后继续或调整模型。</p> : null}
    {view.error ? <details onToggle={event=>setDetailsOpen(event.currentTarget.open)}><summary>错误详情 · {view.error.code}</summary><pre>{view.error.originalMessage}</pre></details> : null}
    <div className="turnRecoveryActions">
      {job?.status === "waiting" ? <><button type="button" onClick={() => onAction("now")}>立即重试</button><button type="button" onClick={() => onAction("cancel")}>取消自动重试</button></> : null}
      {job?.status!=='running'&&onSelectModel?<button type="button" onClick={()=>{close();onSelectModel();}}>切换模型</button>:null}
    </div>
  </div></div>,document.body);
}
