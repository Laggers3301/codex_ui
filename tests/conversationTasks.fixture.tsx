import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationTasks} from '../src/ConversationTasks';
import '../src/styles.css';
import '../src/globalDialogs.css';
import '../src/dialogControlScale.css';
declare global {interface Window {changeTaskScope:()=>void;}}
function App(){
  const [draft,setDraft]=useState('请保留这段多行草稿\n第二行内容'),[other,setOther]=useState(false),[native,setNative]=useState(true),[opened,setOpened]=useState('');
  window.changeTaskScope=()=>setOther(value=>!value);
  const user=other?'bob':'alice',thread=other?'thread-b':'thread-a';
  return <main className="conversation" style={{height:'100dvh',padding:'16px',paddingBottom:90,boxSizing:'border-box'}}>
    <div style={{flex:1}}/><textarea aria-label="任务输入" value={draft} onChange={event=>setDraft(event.target.value)} style={{height:90,flexShrink:0}}/>
    <ConversationTasks key={`${user}:${thread}`} userId={user} projectId="project" threadId={thread} native={native} parentRunning={false}
      agents={other?[]:[{id:'agent-a',name:'检查接口',model:'Sonnet',state:'running'},{id:'agent-old',name:'审查文档',state:'completed',summary:'文档检查已完成'}]}
      directoryPage={{total:other?0:2,activeCount:other?0:1,historyCount:1,unknownCount:0,hasMore:false,nextCursor:null}}
      onOpenAgent={id=>setOpened(id)} onOpenHistory={()=>setOpened('all')}/>
    <button type="button" style={{position:'absolute',top:16,left:16}} onClick={()=>setNative(value=>!value)}>切换运行引擎</button><output style={{position:'absolute',top:52,left:16}} aria-label="已打开的执行记录">{opened}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
