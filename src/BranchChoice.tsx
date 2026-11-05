import {useEffect,useId,useLayoutEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {selectMenuPosition} from "./selectMenuPosition";
import {usePopoverEscape} from "./usePopoverEscape";

export function BranchChoice({label,value,options,disabled,onChange}:{label:string;value:string;options:{value:string;label:string;disabled?:boolean}[];disabled?:boolean;onChange(value:string):void}){
  const [open,setOpen]=useState(false),[closing,setClosing]=useState(false);
  const [position,setPosition]=useState<ReturnType<typeof selectMenuPosition>|null>(null);
  const root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),id=useId();
  function hide(){if(timer.current)clearTimeout(timer.current);setClosing(true);timer.current=setTimeout(()=>{setOpen(false);setClosing(false);},160);}
  useEffect(()=>()=>{if(timer.current)clearTimeout(timer.current);},[]);
  useEffect(()=>{if(!open)return;const frame=requestAnimationFrame(()=>menu.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]:not(:disabled),button:not(:disabled)')?.focus());return()=>cancelAnimationFrame(frame);},[open]);
  useLayoutEffect(()=>{if(!open)return;const update=()=>{if(!button.current||!menu.current)return;const v=visualViewport;setPosition(selectMenuPosition(button.current.getBoundingClientRect(),button.current.offsetWidth,menu.current.scrollHeight+10,{width:v?.width??innerWidth,height:v?.height??innerHeight,left:v?.offsetLeft,top:v?.offsetTop}));};update();window.addEventListener("resize",update);window.addEventListener("scroll",update,true);return()=>{window.removeEventListener("resize",update);window.removeEventListener("scroll",update,true);};},[open,options.length]);
  useEffect(()=>{if(!open)return;const dismiss=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node)&&!menu.current?.contains(e.target as Node))hide();};document.addEventListener("pointerdown",dismiss,true);return()=>document.removeEventListener("pointerdown",dismiss,true);},[open]);
  usePopoverEscape(open,()=>{hide();button.current?.focus();});
  const selected=options.find(o=>o.value===value);
  return <div ref={root} className="branchChoice"><span id={`${id}-label`} className="branchChoiceLabel">{label}</span>
    <button ref={button} type="button" className="polishedSelectTrigger branchChoiceTrigger" aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="listbox" aria-controls={open?id:undefined} aria-expanded={open&&!closing} disabled={disabled} onClick={()=>{if(open)hide();else{setPosition(null);setClosing(false);setOpen(true);}}}><span id={`${id}-value`}>{selected?.label??value}</span><span className="polishedSelectChevron" aria-hidden="true"/></button>
    {open&&typeof document!=="undefined"?createPortal(<div id={id} ref={menu} className={`polishedSelectMenu branchChoiceMenu${closing?" uiClosing":""}`} role="listbox" aria-label={label} aria-hidden={closing} inert={closing} style={{position:"fixed",zIndex:12060,left:position?.left??0,top:position?.top??0,width:position?.width??260,maxHeight:position?.maxHeight??300,visibility:position?"visible":"hidden"}} onKeyDown={e=>{if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();const nodes=[...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],index=nodes.indexOf(document.activeElement as HTMLButtonElement);nodes[(index+(e.key==="ArrowDown"?1:-1)+nodes.length)%nodes.length]?.focus();}}}>
      {options.map(o=><button type="button" role="option" aria-selected={o.value===value} disabled={o.disabled} key={o.value} className={`polishedSelectOption${o.value===value?" selected":""}`} onClick={()=>{onChange(o.value);hide();button.current?.focus();}}><span>{o.label}</span><span className="polishedSelectCheck" aria-hidden="true">{o.value===value?"✓":""}</span></button>)}
    </div>,document.body):null}
  </div>;
}
