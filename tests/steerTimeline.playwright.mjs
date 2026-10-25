import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
const origin='http://127.0.0.1:4574';
const secret=(await fs.readFile(new URL('../data/auth/session-secret',import.meta.url),'utf8')).trim();
const payload=Buffer.from(JSON.stringify({u:'qa-user',exp:Date.now()+300000})).toString('base64url');
const cookie=payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
const evidence='./output/qa/steer-timeline-20261025';await fs.mkdir(evidence,{recursive:true,mode:0o700});
const project={id:'steer-project',name:'引导排序隔离验收',rootPath:'/fixture',userId:'qa',defaultModel:'gpt-6.1-sol',defaultReasoningEffort:'medium',defaultSandbox:'danger-full-access',defaultApprovalPolicy:'never'};
const baseItems=[{id:'original-user',type:'userMessage',text:'最初的问题',timelineAt:'2020-01-01T00:00:00Z'},{id:'original-answer',type:'agentMessage',text:'引导之前已经显示的回答',timelineAt:'2020-01-01T00:00:01Z',completed:true}];
const browser=await chromium.launch({headless:true});const results=[],errors=[];let writes=0;
try {
  for(const mobile of [false,true])for(const theme of ['light','dark']) {
    let persisted=false;
    const page=await browser.newPage({viewport:mobile?{width:393,height:852}:{width:1280,height:900}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.context().addCookies([{name:'codex_remote_session_4575',value:cookie,url:origin,httpOnly:true,sameSite:'Lax'}]);
    await page.addInitScript(()=>{
      localStorage.setItem('codex-web-user-id','qa');localStorage.setItem('codex-v2-project-qa','steer-project');localStorage.setItem('codex-v2-expanded-projects-qa','["steer-project"]');
      class Socket extends EventTarget {
        static OPEN=1;static CONNECTING=0;static CLOSED=3;readyState=0;requests=[];
        queue=[{id:'queued-1',input:[{type:'text',text:'现在补充的引导问题'}]},{id:'queued-2',input:[{type:'text',text:'保留到下轮的排队问题'}]}];
        constructor(){super();window.steerSocket=this;setTimeout(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));this.emit({type:'hello',data:{liveState:this.snapshot(),turnProgress:[],pendingServerRequests:[]}})},20)}
        snapshot(){return{activeTurns:[{threadId:'steer-thread',turnId:'steer-turn',status:'running',startedAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:01Z'}],agentMessages:[],reasoningMessages:[],toolItems:[]}}
        emit(item){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(item)}))}
        send(raw){const x=JSON.parse(raw);this.requests.push(x.type);
          if(x.type==='transport.ping')this.emit({type:'transport.pong'});
          else if(x.type==='turn.queue.list')this.emit({type:'ack',requestId:x.requestId,ok:true,data:{threadId:'steer-thread',data:this.queue}});
          else if(x.type==='turn.queue.steer'){
            this.queue=this.queue.filter(q=>q.id!==x.queuedSubmissionId);
            // New output deliberately arrives before the steer ack/history,
            // with a server clock years behind the browser's local clock.
            setTimeout(()=>{
              this.emit({type:'live.reasoning',data:{itemId:'steer-reason',threadId:'steer-thread',turnId:'steer-turn',text:'引导后的思考摘要',completed:false,sequence:10,startedAt:'2020-01-01T00:00:05Z',updatedAt:'2020-01-01T00:00:05Z'}});
              this.emit({type:'live.tool',data:{itemId:'steer-tool',threadId:'steer-thread',turnId:'steer-turn',tool:'exec',input:'fixture only',output:'ok',completed:true,sequence:11,startedAt:'2020-01-01T00:00:06Z',updatedAt:'2020-01-01T00:00:06Z'}});
              this.emit({type:'live.agent.delta',data:{itemId:'steer-answer',threadId:'steer-thread',turnId:'steer-turn',delta:'引导后的新回答',textOffset:0,sequence:12,startedAt:'2020-01-01T00:00:07Z',completed:false,streamState:'streaming'}});
            },100);
            setTimeout(()=>this.emit({type:'ack',requestId:x.requestId,ok:true,data:{threadId:'steer-thread'}}),1000);
          } else if(x.requestId)this.emit({type:'ack',requestId:x.requestId,ok:true,data:{data:[]}});
        }
        close(){this.readyState=3;this.dispatchEvent(new Event('close'))}
      }window.WebSocket=Socket;
    });
    await page.route('**/api/**',async route=>{
      if(!['GET','HEAD'].includes(route.request().method()))writes++;
      const p=new URL(route.request().url()).pathname;let json={data:[]};
      const thread={id:'steer-thread',name:'引导实时排序验收',cwd:'/fixture',createdAt:1,updatedAt:persisted?2:1,status:'active',configuredModel:'gpt-6.1-sol',turns:[{id:'steer-turn',status:'running',items:persisted?[...baseItems,{id:'native-steer',type:'userMessage',text:'现在补充的引导问题',timelineAt:'2020-01-01T00:00:04Z'},{id:'steer-answer',type:'agentMessage',text:'引导后的新回答',timelineAt:'2020-01-01T00:00:07Z'}]:baseItems}]};
      if(p==='/api/users')json={data:[{id:'qa',name:'qa'}],defaultUserId:'qa'};
      else if(p==='/api/projects')json={data:[project],projectRoot:'/fixture'};
      else if(p==='/api/projects/steer-project/threads')json={data:[thread]};
      else if(p==='/api/threads/steer-thread')json={thread,history:{totalItems:thread.turns[0].items.length,returnedItems:thread.turns[0].items.length,before:0,hasOlder:false}};
      else if(p.endsWith('/execution-settings'))json={data:{sandbox:'danger-full-access',approvalPolicy:'never'}};
      else if(p.endsWith('/context')||p.endsWith('/side-chat'))json={data:null};
      else if(p.endsWith('/subagents'))json={data:[],page:{total:0,activeCount:0,historyCount:0,hasMore:false}};
      else if(p==='/api/pets')json={pets:[],activePetId:null,visible:false,position:null};
      else if(p==='/api/codex/account-pool')json={data:{accounts:[],currentThreadAccountId:null}};
      else if(p==='/api/codex/provider-quotas')json={data:{items:[],loading:false}};
      else if(p==='/api/models')json={data:[{id:'sol',label:'gpt-6.1-sol medium',model:'gpt-6.1-sol',effort:'medium'}]};
      await route.fulfill({json});
    });
    await page.goto(origin+'/?project=steer-project&thread=steer-thread');await page.getByText('最初的问题',{exact:true}).waitFor();await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.getByRole('button',{name:'调整方向',exact:true}).waitFor();
    assert.equal(await page.locator('.conversationTurnRow .kind-user').count(),1,'ordinary queued text stays outside the current turn');
    assert.equal(await page.evaluate(()=>window.steerSocket.queue.length),2);
    await page.getByRole('button',{name:'调整方向',exact:true}).click();
    const row=page.locator('.conversationTurnRow[data-turn-id="steer-turn"]');
    await row.locator('.kind-user').filter({hasText:'现在补充的引导问题'}).waitFor({timeout:1000});
    const immediately=await row.evaluate(n=>[...n.children].map(x=>x.textContent));
    const userIndex=immediately.findIndex(t=>t.includes('现在补充的引导问题'));
    assert.ok(userIndex>=0&&immediately[userIndex+1]==='正在思考','thinking is immediately after the optimistic steer');
    await row.getByText('引导后的新回答',{exact:true}).waitFor();
    const check=()=>row.evaluate(n=>{const nodes=[...n.children];return{user:nodes.findIndex(x=>x.classList.contains('kind-user')&&x.textContent.includes('现在补充的引导问题')),thinking:nodes.findIndex(x=>x.classList.contains('v2ThinkingLine')),tool:nodes.findIndex(x=>x.classList.contains('toolBundle')),answer:nodes.findIndex(x=>x.classList.contains('kind-agent')&&x.textContent.includes('引导后的新回答')),turns:document.querySelectorAll('.conversationTurnRow').length}});
    const early=await check();assert.ok(early.user<early.thinking&&early.thinking<early.tool&&early.tool<early.answer,'all early output follows the steer: '+JSON.stringify(early));assert.equal(early.turns,1);
    await page.waitForTimeout(2500);const afterAck=await check();assert.deepEqual(afterAck,early,'ack and stale history must not reorder output');
    assert.equal(await page.evaluate(()=>window.steerSocket.queue.length),1);assert.ok(await page.getByText('保留到下轮的排队问题',{exact:true}).count());
    const requests=await page.evaluate(()=>window.steerSocket.requests);assert.equal(requests.filter(x=>x==='turn.queue.steer').length,1);assert.ok(!requests.some(x=>['turn.start','thread.start'].includes(x)),'steer never starts a new turn');
    await page.screenshot({path:`${evidence}/${mobile?'phone':'desktop'}-${theme}.png`});
    // Explicitly reopen the fixture thread; fake IDs are intentionally not
    // valid production UUIDs and must not rely on saved last-thread routing.
    persisted=true;await page.goto(origin+'/?project=steer-project&thread=steer-thread');
    try{await page.getByText('引导后的新回答',{exact:true}).waitFor({timeout:5000})}catch(error){await page.screenshot({path:`${evidence}/refresh-failure.png`});console.log(JSON.stringify({fixtureBody:(await page.locator('body').innerText()).slice(-4000),errors}));throw error;}
    assert.equal(await page.locator('.conversationTurnRow .kind-user').count(),2,'refresh has exactly the two native user messages');
    const refresh=await page.locator('.conversationTurnRow').innerText();assert.ok(refresh.indexOf('现在补充的引导问题')<refresh.indexOf('引导后的新回答'));
    results.push({mobile,theme,early,afterAck,oneTurn:true,remainingQueued:1,refreshOrdered:true});await page.close();
  }
  assert.deepEqual(errors,[]);assert.equal(writes,0);await fs.writeFile(`${evidence}/results.json`,JSON.stringify({at:new Date().toISOString(),results,errors,conversationWrites:writes},null,2),{mode:0o600});console.log(JSON.stringify({cases:results.length,errors,writes}));
}finally{await browser.close()}
