import {useEffect,useRef,useState} from "react";
import {requestComposerPrediction} from "./api";

export function useComposerPrediction(user:string,project:string|undefined,thread:string|undefined,turn:string|undefined,modelKey:string,blocked:boolean) {
  const key=`${user}:${thread??""}:${turn??""}:${modelKey}`;
  const [result,setResult]=useState<{key:string;text:string}|null>(null);
  const attempted=useRef(new Set<string>());
  useEffect(()=>{
    if(blocked||!project||!thread||!turn||attempted.current.has(key))return;
    const abort=new AbortController();
    // Delay avoids unnecessary requests during rapid thread switching.
    const timer=window.setTimeout(()=>{
      attempted.current.add(key);while(attempted.current.size>200)attempted.current.delete(attempted.current.values().next().value!);
      void requestComposerPrediction(project,thread,turn,modelKey,abort.signal).then(response=>{
        if(abort.signal.aborted||response.data.sourceTurnId!==turn)return;
        const text=response.data.eligible?response.data.text?.trim():null;
        setResult(text?{key,text}:null);
      }).catch(()=>{});
    },650);
    return()=>{clearTimeout(timer);abort.abort();};
  },[key,project,thread,turn,modelKey,blocked]);
  return {key,text:!blocked&&result?.key===key?result.text:null};
}
