import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {it,expect} from 'vitest';
import {ClaudeSessionStorage,type ClaudeConversation} from './claudeSessionStorage.js';
import {claudeSubagentDirectory,claudeSubagentPage} from './claudeSubagents.js';
it('reads native agent logs with owned lineage, bounded pages and a branch-time cutoff',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-agents-')),storage=new ClaudeSessionStorage(path.join(root,'store'));
  try{
    const native='11111111-1111-4111-8111-111111111111',cwd=path.join(root,'work'),configRoot=path.join(root,'config');fs.mkdirSync(cwd);
    const project=path.join(configRoot,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'));fs.mkdirSync(path.join(project,native,'subagents'),{recursive:true});fs.writeFileSync(path.join(project,native+'.jsonl'),'');
    const cutoff=Date.now()+1000,parent={id:'parent',userId:'alice',projectId:'p',cwd,configRoot,nativeSessionId:native,createdAt:1,updatedAt:1,initialized:true,model:'reclaude-opus@1'} as ClaudeConversation;
    storage.save(parent);
    const message=(id:string,text:string,time:number)=>({type:'assistant',timestamp:new Date(time).toISOString(),message:{id,content:[{type:'text',text}]}});
    const instruction={type:'user',uuid:'native-user',timestamp:new Date(cutoff-1500).toISOString(),message:{role:'user',content:'子代理用户原始指令'}};
    fs.writeFileSync(path.join(project,native,'subagents/agent-one.jsonl'),[instruction,message('old','旧证据',cutoff-1000),message('future','分支之后不能继承',cutoff+1000)].map(v=>JSON.stringify(v)).join('\n')+'\n');
    const child={...parent,id:'child',nativeSessionId:'22222222-2222-4222-8222-222222222222',parentThreadId:parent.id,createdAt:cutoff};storage.save(child);
    const directory=await claudeSubagentDirectory(storage,child,{});expect(directory.data).toHaveLength(1);expect(directory.data[0]).toMatchObject({id:'one',inherited:true,state:'unknown'});
    parent.nativeTasks=[{id:'one',kind:'agent',description:'原生任务',status:'running',background:true}];
    expect((await claudeSubagentDirectory(storage,parent,{view:'active',activeRuntime:true})).data[0]).toMatchObject({id:'one',state:'running'});
    expect((await claudeSubagentDirectory(storage,parent,{activeRuntime:false})).data[0].state).toBe('unknown');
    parent.nativeTasks[0].status='completed';expect((await claudeSubagentDirectory(storage,parent,{})).data[0].state).toBe('completed');
    const page=await claudeSubagentPage(storage,child,'one');expect(JSON.stringify(page)).toContain('旧证据');expect(JSON.stringify(page)).not.toContain('分支之后');
    expect(page.thread.turns[0].items.find(item=>item.type==='userMessage')).toMatchObject({content:[{type:'text',text:'子代理用户原始指令'}],timelineAt:instruction.timestamp});
    await expect(claudeSubagentPage(storage,child,'../one')).rejects.toThrow('没有此');
    await expect(claudeSubagentDirectory(storage,{...child,userId:'bob'},{})).rejects.toThrow('owner');
  }finally{storage.close();fs.rmSync(root,{recursive:true,force:true});}
});
