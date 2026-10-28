import {useEffect,useId,useRef} from 'react';
import {createPortal} from 'react-dom';
import {Info,X} from './PanelIcons';
import './taskNotificationSettings.css';

export type TaskNotificationDialogProps = {
  enabled:boolean; busy:boolean; ready:boolean; canTest:boolean; closing?:boolean;
  status?:string; error?:string; onToggle:()=>void; onTest:()=>void; onClose:()=>void;
};

export function TaskNotificationDialog({enabled,busy,ready,canTest,closing=false,status,error,onToggle,onTest,onClose}:TaskNotificationDialogProps){
  const title=useId(),privacy=useId(),panel=useRef<HTMLElement>(null),close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>('[aria-label="关闭任务通知"]')?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current();}
      if(event.key==='Tab'){
        const controls=[...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),summary,a[href]')].filter(el=>el.getClientRects().length>0);
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',key,true);
    return()=>{document.removeEventListener('keydown',key,true);const target=previous instanceof HTMLElement&&previous!==document.body&&(previous.tabIndex>=0||previous.isContentEditable)&&previous.getClientRects().length&&!previous.closest('[inert],[hidden]')?previous:document.querySelector<HTMLElement>('.v2AccountTrigger');target?.focus({preventScroll:true});};
  },[]);
  return createPortal(<div className={`taskNotificationScrim uiExitLayer${closing?' uiClosing':''}`} aria-hidden={closing} inert={closing} onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section ref={panel} className="taskNotificationDialog" role="dialog" aria-modal="true" aria-labelledby={title} aria-describedby={privacy}>
      <header><h2 id={title}>任务通知</h2><button type="button" className="taskNotificationIcon" aria-label="关闭任务通知" onClick={onClose}><X size={16}/></button></header>
      <div className="taskNotificationRow"><span>此设备通知</span><button type="button" className="taskNotificationSwitch" role="switch" aria-label="此设备任务通知" aria-checked={enabled} disabled={busy||!ready} onClick={onToggle}><span/></button></div>
      <ul className="taskNotificationEvents" aria-label="通知事件"><li>回答完成</li><li>等待批准</li><li>需要回答</li></ul>
      <p id={privacy} className="taskNotificationPrivacy">通知含会话名与内容摘要，锁屏可见。</p>
      {error?<p className="taskNotificationError" role="alert">{error}</p>:status?<p className="taskNotificationStatus" role="status">{status}</p>:!ready?<p className="taskNotificationStatus" role="status">通知服务暂不可用，请稍后重试。</p>:null}
      <footer><details className="taskNotificationHelp"><summary className="taskNotificationIcon" aria-label="通知使用帮助" title="通知使用帮助"><Info size={16}/></summary><div>需使用 HTTPS，并允许浏览器和系统通知。iPhone 请从添加到主屏幕的网页 App 中开启。测试会发往你已开启通知的设备；请先打开一个会话。{!ready?' 通知服务暂不可用，请稍后重试。':''}</div></details>
        <button className="taskNotificationTest" type="button" disabled={!enabled||busy||!canTest||!ready} title={!canTest?'打开一个会话后可测试':undefined} onClick={onTest}>{busy?'处理中…':enabled&&!canTest?'打开会话后测试':'发送测试通知'}</button>
      </footer>
    </section>
  </div>,document.body);
}
