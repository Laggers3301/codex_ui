import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {expect,it} from 'vitest';
import {ClaudeSessionStorage,type ClaudeConversation} from './claudeSessionStorage.js';
import {historyScopes,createClaudeHistoryReader} from './claudeHistoryRecall.js';
import {queryClaudeHistory} from './claudeHistoryRecallWorker.js';
import {createRequire} from 'node:module';
import {createHistoryMcpServer} from './claudeRuntime.js';
it('retrieves full older text in bounded pages, including inherited history only up to the fork point',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-history-recall-')),storage=new ClaudeSessionStorage(root);
  try{
    const row=(id:string,parentThreadId?:string,inheritedTurnCount?:number)=>({id,nativeSessionId:id==='parent'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222',userId:'alice',projectId:'p',cwd:root,configRoot:root,parentThreadId,inheritedTurnCount,initialized:true,model:'reclaude-opus@1',createdAt:1,updatedAt:1} as ClaudeConversation);
    const parent=row('parent');storage.save(parent);storage.saveTurn('parent',{id:'old',items:[{type:'agentMessage',text:'OLD_SECRET_MARKER '+ '完整旧证据'.repeat(3000)}]});
    const child=row('child','parent',1);storage.save(child);
    storage.saveTurn('parent',{id:'future',items:[{type:'agentMessage',text:'FUTURE_FORBIDDEN'}]});storage.saveTurn('child',{id:'new',items:[{type:'userMessage',content:[{type:'text',text:'最新问题'}]}]});
    const scopes=historyScopes(storage,child),db=path.join(root,'sessions.sqlite');
    const found=queryClaudeHistory(db,'alice',scopes,{kind:'search',query:'OLD_SECRET_MARKER'}) as any;expect(found.results).toHaveLength(1);
    expect((queryClaudeHistory(db,'alice',scopes,{kind:'search',query:'FUTURE_FORBIDDEN'}) as any).results).toEqual([]);
    let offset=0,all='';for(;;){const part=queryClaudeHistory(db,'alice',scopes,{kind:'read',ref:found.results[0].ref,offset}) as any;all+=part.text;if(part.nextOffset===null)break;offset=part.nextOffset;}
    expect(all).toBe('OLD_SECRET_MARKER '+'完整旧证据'.repeat(3000));
    expect(()=>queryClaudeHistory(db,'bob',scopes,{kind:'search',query:'OLD_SECRET_MARKER'})).toThrow('forbidden');
    const forged=Buffer.from(JSON.stringify({threadId:'parent',id:'future',item:0})).toString('base64url');expect(()=>queryClaudeHistory(db,'alice',scopes,{kind:'read',ref:forged})).toThrow('branch boundary');
    const asyncReader=createClaudeHistoryReader(storage,child);expect((await asyncReader.search('OLD_SECRET_MARKER') as any).results).toHaveLength(1);
    expect((await asyncReader.search('最新问题') as any).results).toHaveLength(1);
  }finally{storage.close();fs.rmSync(root,{recursive:true,force:true});}
},15000);
it('registers working search/read tools with the real SDK MCP transport, without a model call',async()=>{
  const require=createRequire(new URL('../integrations/claude-session-tools/package.json',import.meta.url));
  const {Client}=await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const {InMemoryTransport}=await import(require.resolve('@modelcontextprotocol/sdk/inMemory.js'));
  const server=await createHistoryMcpServer({search:async q=>({results:[{ref:'fixture-reference',excerpt:q}]}),read:async(ref,offset)=>({ref,offset,text:'完整旧记录'})});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const client=new Client({name:'history-qa',version:'1.0.0'});
  try{
    await server.instance.connect(serverTransport);await client.connect(clientTransport);
    const tools=await client.listTools();expect(tools.tools.map((x:any)=>x.name)).toEqual(['search','read']);
    const found=await client.callTool({name:'search',arguments:{query:'早期约定'}});expect(JSON.stringify(found)).toContain('fixture-reference');
    const full=await client.callTool({name:'read',arguments:{ref:'fixture-reference',offset:0}});expect(JSON.stringify(full)).toContain('完整旧记录');
  }finally{await client.close();await server.instance.close();}
});
