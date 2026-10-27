import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
// Production static assets only. Every API and WebSocket is a private fixture.
const origin=process.env.QA_ORIGIN??'http://127.0.0.1:4574';
if(process.env.QA_FIXTURE_AUTH==='1'&&process.env.QA_QUOTA_FROM_API==='1')throw new Error('Fixture credentials cannot verify production quota');
const secret=process.env.QA_FIXTURE_AUTH==='1'?'fixture-only-session-secret':(await fs.readFile(new URL('../data/auth/session-secret',import.meta.url),'utf8')).trim();
const payload=Buffer.from(JSON.stringify({u:'qa-user',exp:Date.now()+300000})).toString('base64url');
const cookie=payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
let liveQuota=null;
if(process.env.QA_QUOTA_FROM_API==='1'){
  for(let attempt=0;attempt<35;attempt++){
    const response=await fetch(origin+'/api/codex/provider-quotas',{headers:{Cookie:`codex_remote_session_4575=${cookie}`},signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);const body=await response.json();liveQuota=body.data.items.find(q=>q.id==='ark');assert.ok(liveQuota);
    if(!body.data.loading&&Date.now()-Date.parse(liveQuota.updatedAt)<120000)break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(liveQuota.status==='ready'&&Date.now()-Date.parse(liveQuota.updatedAt)<120000,'live quota must be fresh rather than a pre-restart cache');
}
const evidence=process.env.QA_TERRA_PICKER==='1'?'./output/qa/terra-picker-20261027':'./output/qa/quota-error-banner-20261025'+(liveQuota?'/real-quota':'');await fs.mkdir(evidence,{recursive:true,mode:0o700});
const expectedReset=liveQuota?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(liveQuota.periods.find(p=>p.label==='weekly').resetsAt)):'2099/10/26 00:00';
const project={id:'quota-project',name:'额度横条隔离验收',rootPath:'/fixture',userId:'qa',defaultModel:'kimi-k3',defaultReasoningEffort:'medium',defaultSandbox:'danger-full-access',defaultApprovalPolicy:'never'};
const thread={id:'quota-thread',name:'额度错误测试',cwd:'/fixture',createdAt:1,updatedAt:1,status:'active',configuredModel:'kimi-k3',turns:[{id:'quota-turn',status:'running',items:[{id:'quota-user',type:'userMessage',text:'额度横条隔离验收问题'}]}]};
const browser=await chromium.launch({headless:true});const results=[],errors=[];let writes=0;
try {
  for(const mobile of [false,true])for(const theme of ['light','dark']) {
    const page=await browser.newPage({viewport:mobile?{width:393,height:852}:{width:1280,height:900}});
    await page.context().addCookies([{name:'codex_remote_session_4575',value:cookie,url:origin,httpOnly:true,sameSite:'Lax'}]);
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      localStorage.setItem('codex-web-user-id','qa');localStorage.setItem('codex-v2-project-qa','quota-project');localStorage.setItem('codex-v2-expanded-projects-qa','["quota-project"]');
      class Socket extends EventTarget {
        static OPEN=1;static CONNECTING=0;static CLOSED=3;readyState=0;
        constructor(){super();window.quotaSocket=this;setTimeout(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));this.emit({type:'hello',data:{liveState:{activeTurns:[],agentMessages:[],toolItems:[],reasoningMessages:[]},turnProgress:[],pendingServerRequests:[]}})},20)}
        emit(item){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(item)}))}
        send(raw){const x=JSON.parse(raw);if(x.type==='transport.ping')this.emit({type:'transport.pong'});else if(x.requestId)this.emit({type:'ack',ok:true,requestId:x.requestId,data:{data:[]}})}
        close(){this.readyState=3;this.dispatchEvent(new Event('close'))}
      }window.WebSocket=Socket;
    });
    await page.route('**/api/**',async route=>{
      if(!['GET','HEAD'].includes(route.request().method()))writes++;
      const p=new URL(route.request().url()).pathname;let json={data:[]};
      if(p==='/api/users')json={data:[{id:'qa',name:'qa'}],defaultUserId:'qa'};
      else if(p==='/api/projects')json={data:[project],projectRoot:'/fixture'};
      else if(p==='/api/projects/quota-project/threads')json={data:[thread]};
      else if(p==='/api/threads/quota-thread')json={thread,history:{totalItems:1,returnedItems:1,before:0,hasOlder:false}};
      else if(p.endsWith('/execution-settings'))json={data:{sandbox:'danger-full-access',approvalPolicy:'never'}};
      else if(p.endsWith('/context')||p.endsWith('/side-chat'))json={data:null};
      else if(p.endsWith('/subagents'))json={data:[],page:{total:0,activeCount:0,historyCount:0,hasMore:false}};
      else if(p==='/api/pets')json={pets:[],activePetId:null,visible:false,position:null};
      else if(p==='/api/codex/account-pool')json={data:{accounts:['100004','100001','100002','100003'].map(id=>({id,label:id,health:process.env.QA_ACCOUNT_CACHE==='1'?'degraded':'ready',lastError:process.env.QA_ACCOUNT_CACHE==='1'?'rateLimits: Timed out waiting for Codex response':null,kind:'codex-account',quota:{account:{type:'chatgpt'},rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:null}},resetCredits:null,usage:null,errors:[],updatedAt:new Date().toISOString()}})),currentThreadAccountId:null}};
      else if(p==='/api/codex/provider-quotas')json={data:{loading:false,items:[liveQuota??{id:'ark',name:'Ark',status:'ready',updatedAt:new Date().toISOString(),stale:false,message:null,periods:[{label:'session',usedPercent:0,resetsAt:'2099-10-25T20:13:47+08:00'},{label:'weekly',usedPercent:100,resetsAt:'2099-10-26T00:00:00+08:00'}]}]}};
      else if(p==='/api/models')json={data:[{id:'kimi',label:'kimi-k3 medium',model:'kimi-k3',effort:'medium'},...(process.env.QA_TERRA_PICKER==='1'?['max','xhigh','high','medium','low'].map(effort=>({id:'gpt-6.1-terra:'+effort,label:'GPT-6.1-Terra '+effort,model:'gpt-6.1-terra',effort})):[])]};
      await route.fulfill({json});
    });
    await page.goto(origin+'/?project=quota-project&thread=quota-thread');await page.getByText('额度横条隔离验收问题',{exact:true}).waitFor();
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    if(process.env.QA_TERRA_PICKER==='1'){
      await page.locator('.composerTools .groupedModelPicker .polishedSelectTrigger').click();
      await page.locator('.groupedModelMenu .groupedModelRow').filter({hasText:/^GPT$/}).first().click();
      const terra=page.locator('.groupedModelProfile').filter({hasText:'GPT-6.1-Terra'});
      await terra.first().waitFor();assert.equal(await terra.count(),5);
      for(const effort of ['max','xhigh','high','medium','low'])assert.ok((await terra.allTextContents()).some(text=>text.trim()==='GPT-6.1-Terra '+effort));
      await page.waitForTimeout(450); // Capture the settled menu, not its staggered entry frames.
      await page.screenshot({path:`${evidence}/${mobile?'phone':'desktop'}-${theme}-picker.png`});
      await page.locator('.composerTools .groupedModelPicker .polishedSelectTrigger').click();
    }
    await page.evaluate(()=>window.quotaSocket.emit({type:'codex.notification',data:{method:'turn/completed',params:{threadId:'quota-thread',turn:{id:'quota-turn',status:'failed',error:{httpStatusCode:429,message:'429 Too Many Requests'}}}}}));
    const banner=page.locator('.providerErrorBanner');await banner.waitFor();await banner.getByText(/每周额度已耗尽.*重置时间/).first().waitFor();
    const text=await banner.innerText();assert.ok(text.includes(expectedReset)&&text.includes('官方额度查询'));
    const box=await banner.boundingBox();assert.ok(box.x>=-1&&box.x+box.width<=page.viewportSize().width+1);
    await page.screenshot({path:`${evidence}/${mobile?'phone':'desktop'}-${theme}-banner.png`});
    await page.locator('.quotaButton').click();const tab=page.locator('[data-account-id="provider:ark"]');await tab.waitFor();await page.waitForTimeout(300);
    if(process.env.QA_ACCOUNT_CACHE==='1'){
      assert.equal(await page.locator('.accountPoolTab.degraded[data-account-id]:not([data-account-id^="provider:"])').count(),0);
      await page.getByText('额度查询暂时失败 · 显示缓存，后台重试中',{exact:true}).waitFor();
    }
    const baseline=await page.locator('.accountPoolPopover').boundingBox();
    assert.equal((await tab.innerText()).replace(/\s/g,''),'Ark0%');await tab.click();
    const details=page.locator('.providerQuotaDetails');await details.getByText(/每周额度已耗尽/).waitFor();assert.ok((await details.innerText()).includes('100%'));
    await page.waitForTimeout(300);const arkBox=await page.locator('.accountPoolPopover').boundingBox();
    assert.ok(Math.abs(arkBox.width-baseline.width)<1.5,'Ark must not change popover width: '+JSON.stringify({baseline,arkBox}));
    assert.ok(arkBox.height<=baseline.height+1.5,'Ark content stays compact without reserved empty height: '+JSON.stringify({baseline,arkBox}));
    assert.ok(await details.evaluate(n=>n.scrollWidth<=n.clientWidth+1),'provider details never overflow horizontally');
    assert.equal(await details.locator('.providerQuotaHint').count(),0);
    assert.ok((await details.innerText()).includes('更新时间'));
    const valueColors=await details.locator('.quotaPopoverRows strong').first().evaluate(n=>({value:getComputedStyle(n).color,children:[...n.querySelectorAll('span')].map(s=>getComputedStyle(s).color)}));
    assert.ok(valueColors.children.every(c=>c===valueColors.value),'all values and reset dates use the same foreground as Codex quota values');
    await page.screenshot({path:`${evidence}/${mobile?'phone':'desktop'}-${theme}-quota.png`});
    results.push({mobile,theme,banner:text,tab:await tab.innerText(),quota:await details.innerText(),baseline,arkBox});await page.close();
  }
  assert.deepEqual(errors,[]);assert.equal(writes,0);
  await fs.writeFile(`${evidence}/results.json`,JSON.stringify({at:new Date().toISOString(),quotaSource:liveQuota?'read-only production quota API':'isolated fixture',errorSource:'isolated WebSocket fixture',results,errors,conversationWrites:writes},null,2),{mode:0o600});console.log(JSON.stringify({cases:results.length,quotaSource:liveQuota?'production read-only API':'fixture',expectedReset,errors,writes}));
}finally{await browser.close()}
