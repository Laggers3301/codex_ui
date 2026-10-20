import {useEffect,useRef,useState} from 'react';
import {EditorState} from '@codemirror/state';
import {EditorView,lineNumbers} from '@codemirror/view';
import {HighlightStyle,syntaxHighlighting,foldGutter} from '@codemirror/language';
import {tags} from '@lezer/highlight';
import {html} from '@codemirror/lang-html';
import './htmlSourcePreview.css';
const sourceHighlight=HighlightStyle.define([
 {tag:tags.tagName,color:'var(--html-syntax-tag)'},
 {tag:[tags.attributeName,tags.propertyName],color:'var(--html-syntax-property)'},
 {tag:[tags.string,tags.attributeValue],color:'var(--html-syntax-string)'},
 {tag:tags.number,color:'var(--html-syntax-number)'},
 {tag:tags.keyword,color:'var(--html-syntax-keyword)'},
 {tag:[tags.comment,tags.documentMeta],color:'var(--html-syntax-comment)'},
]);

// Separate from PreviewZoom: the editor owns a fixed viewport and virtualizes
// long sources. Measuring its full document height would defeat virtualization.
export default function HtmlSourcePreview({source}:{source:string}){
 const host=useRef<HTMLDivElement>(null),editor=useRef<EditorView|null>(null);
 const [formatted,setFormatted]=useState<string|null>(null),[original,setOriginal]=useState(false),[busy,setBusy]=useState(true),[failed,setFailed]=useState(false);
 useEffect(()=>{
  setFormatted(null);setOriginal(false);setBusy(true);setFailed(false);
  let stopped=false,worker:Worker|undefined;
  const finish=(text?:string)=>{if(stopped)return;setFormatted(text??null);setFailed(text===undefined);setBusy(false);worker?.terminate();clearTimeout(timer);};
  const timer=window.setTimeout(()=>finish(),8000);
  try{worker=new Worker(new URL('./htmlSourceFormat.worker.ts',import.meta.url),{type:'module'});worker.onmessage=e=>finish(typeof e.data.text==='string'?e.data.text:undefined);worker.onerror=()=>finish();worker.postMessage({source});}catch{finish();}
  return()=>{stopped=true;clearTimeout(timer);worker?.terminate();};
 },[source]);
 const document=original?source:formatted??(busy?'':source);
 useEffect(()=>{
  if(!host.current)return;
  const view=new EditorView({parent:host.current,state:EditorState.create({doc:document,extensions:[
   EditorState.readOnly.of(true),EditorView.editable.of(false),lineNumbers(),foldGutter(),html(),syntaxHighlighting(sourceHighlight),
   EditorView.contentAttributes.of({'aria-label':'HTML 源码，只读',tabindex:'0'}),
   EditorView.theme({'&':{height:'100%',fontSize:'13px',backgroundColor:'var(--ui-code-bg, var(--bg))',color:'var(--ui-code-content, var(--ui-content))'},'.cm-scroller':{overflow:'auto',fontFamily:'Consolas,"Cascadia Code","SFMono-Regular",var(--pool-ui-font),monospace',lineHeight:'1.65'},'.cm-gutters':{backgroundColor:'transparent',borderRight:'1px solid var(--ui-divider)',color:'var(--ui-content-muted)'},'&.cm-focused':{outline:'none'}})
  ]})});editor.current=view;
  return()=>{view.destroy();editor.current=null;};
 // The editor instance stays mounted while formatting/source mode changes.
 },[]);
 useEffect(()=>{const view=editor.current;if(view&&view.state.doc.toString()!==document)view.dispatch({changes:{from:0,to:view.state.doc.length,insert:document},selection:{anchor:0}});},[document]);
 return <div className="htmlSourceViewer">
  <div className="htmlSourceToolbar"><span>{busy?'正在整理源码…':failed?'原始源码':original?'原始源码':'格式化源码'}</span><button type="button" disabled={busy||!formatted} onClick={()=>setOriginal(v=>!v)}>{original?'格式化显示':'查看原始源码'}</button><small>只读 · 不修改文件</small></div>
  <div className="htmlSourceEditor" ref={host}/>
 </div>;
}
