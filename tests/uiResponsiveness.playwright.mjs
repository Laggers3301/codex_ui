// Production static assets only; all API and WebSocket traffic is simulated.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
import { installMobileChromeFixture } from './mobileChromeFixture.mjs';

const base=process.env.QA_BASE_URL??'http://127.0.0.1:4574',user=process.env.QA_USER_ID;
if(!user)throw Error('Explicit QA_USER_ID required');
const browser=await chromium.launch(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{});
const reports=[],errors=[];
try{
 for(const width of [393,1280])for(const cpuRate of [1,4]){
  const context=await browser.newContext({viewport:{width,height:900},isMobile:width<720,hasTouch:width<720,serviceWorkers:'block'});
  if(process.env.QA_SESSION_SECRET_FILE){
   const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim();
   const p=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');
   await context.addCookies([{name:'codex_remote_session_4575',value:p+'.'+createHmac('sha256',secret).update(p).digest('base64url'),url:base}]);
  }
  await installMobileChromeFixture(context,user);
  await context.addInitScript(()=>{
   const Native=MutationObserver;
   window.shellBench={calls:0,labelWrites:0,callbackMs:0};
   window.MutationObserver=class extends Native{
    constructor(callback){const stats={root:false};super((records,observer)=>{
     const start=performance.now();if(stats.root){window.shellBench.calls++;for(const r of records)if(r.target instanceof Element&&r.target.matches('.listHeader>span:first-child'))window.shellBench.labelWrites++;}
     callback(records,observer);if(stats.root)window.shellBench.callbackMs+=performance.now()-start;
    });this.benchStats=stats;}
    observe(target,options){if(target instanceof Element&&target.id==='root')this.benchStats.root=true;super.observe(target,options);}
   };
  });
  const turns=Array.from({length:24},(_,i)=>({id:`history-${i}`,status:'completed',items:[{id:`u-${i}`,type:'userMessage',text:`隔离测试问题 ${i}`},{id:`a-${i}`,type:'agentMessage',text:('已有回答内容，仅用于浏览器性能测试。 Streaming performance. ').repeat(12),completed:true}]}));
  const thread={id:'mobile-thread',name:'隔离性能验收',cwd:'/fixture',createdAt:1,updatedAt:1,status:'active',configuredModel:'gpt-6.1-sol',turns:[...turns,{id:'perf-turn',status:'running',items:[{id:'perf-user',type:'userMessage',text:'性能测试，不发送模型请求'}]}]};
  await context.route(/\/api\/threads\/mobile-thread(?:\?|$)/,r=>r.fulfill({json:{thread,history:{totalItems:49,returnedItems:49,before:0,hasOlder:false}}}));
  await context.route(/\/api\/projects\/mobile-project\/threads(?:\?|$)/,r=>r.fulfill({json:{data:[thread]}}));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
  await page.goto(`${base}/?project=mobile-project&thread=mobile-thread`);
  await page.getByText('性能测试，不发送模型请求',{exact:true}).waitFor({state:'attached'});
  if(width<720){
   await page.locator('.threadList').evaluate(e=>{if(!e.classList.contains('collapsed'))e.querySelector('.v2SidebarToggle')?.click();});
   await page.waitForFunction(()=>document.querySelector('.threadList')?.classList.contains('collapsed'));
  }
  await page.waitForTimeout(1000);
  const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  const before=await metric();
  const idle=await page.evaluate(async()=>{const start={...window.shellBench};await new Promise(r=>setTimeout(r,2000));const end=window.shellBench;return{shellCalls:end.calls-start.calls,labelWrites:end.labelWrites-start.labelWrites,callbackMs:end.callbackMs-start.callbackMs};});
  const idleEnd=await metric();
  const stream=await page.evaluate(async()=>{
   const pending=[],latencies=[],frames=[],shellStart={...window.shellBench};let text='',last=performance.now(),done=false;
   const observer=new MutationObserver(()=>{
    const target=document.querySelector('.liveAgentStreamTail');if(!target)return;const rendered=target.textContent??'';
    for(const entry of pending)if(!entry.domAt&&rendered.includes(entry.marker)){entry.domAt=performance.now();latencies.push(entry.domAt-entry.at);}
   });observer.observe(document.querySelector('.messages'),{childList:true,subtree:true,characterData:true});
   const frame=now=>{frames.push(now-last);last=now;if(!done)requestAnimationFrame(frame);};requestAnimationFrame(frame);
   for(let i=0;i<50;i++){
    const marker=`PERFPROBE${String(i).padStart(4,'0')}`,delta=marker+' 这是测试增量 Streamed answer.\n\n',offset=text.length;text+=delta;
    pending.push({marker,at:performance.now()});
    window.mobileQaSocket.emit({type:'live.agent.delta',data:{itemId:'perf-answer',threadId:'mobile-thread',turnId:'perf-turn',delta,textOffset:offset,startedAt:'2026-10-30T00:00:00Z',streamState:'streaming',completed:false}});
    await new Promise(r=>setTimeout(r,50));
   }
   await new Promise(r=>setTimeout(r,700));done=true;observer.disconnect();
   latencies.sort((a,b)=>a-b);frames.sort((a,b)=>a-b);
   return{delivered:pending.length,rendered:latencies.length,receiveToDomP50Ms:latencies[Math.floor(latencies.length*.5)]??null,receiveToDomP95Ms:latencies[Math.floor(latencies.length*.95)]??null,frameP95Ms:frames[Math.floor(frames.length*.95)],framesOver33:frames.filter(x=>x>33).length,shellCalls:window.shellBench.calls-shellStart.calls,labelWrites:window.shellBench.labelWrites-shellStart.labelWrites,callbackMs:window.shellBench.callbackMs-shellStart.callbackMs};
  });
  assert.equal(stream.rendered,stream.delivered,'Every simulated delta must reach the DOM');
  if(process.env.QA_ASSERT_OPTIMIZED){assert.ok(idle.shellCalls<15,'Idle UI must not run a self-induced per-frame mutation loop');assert.equal(idle.labelWrites,0,'Unchanged labels must not be rewritten');assert.equal(stream.labelWrites,0,'Streaming must not rewrite shell labels');}
  // The bridge must still repair genuinely replaced controls/labels.
  await page.locator('.threadList .listHeader>span').first().evaluate(e=>{e.textContent='Project';});
  await page.waitForFunction(()=>document.querySelector('.threadList .listHeader>span')?.textContent==='项目');
  await page.locator('.v2ComposerPlus').evaluate(e=>e.remove());await page.locator('.v2ComposerPlus').waitFor({state:'attached'});
  assert.deepEqual(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>/^turn\.(start|interrupt)$|^turn\.queue\.(?!list$)|^thread\.create$/.test(t))),[]);
  reports.push({width,cpuRate,idle:{...idle,layoutCount:idleEnd.LayoutCount-before.LayoutCount,recalcStyleCount:idleEnd.RecalcStyleCount-before.RecalcStyleCount,taskMs:1000*(idleEnd.TaskDuration-before.TaskDuration)},stream,productionWrites:0});
  console.log(JSON.stringify({passed:reports.at(-1)}));await context.close();
 }
 assert.deepEqual(errors,[]);
 const result={at:new Date().toISOString(),reports,errors,productionWrites:0};
 if(process.env.QA_RESULT_FILE)await fs.writeFile(process.env.QA_RESULT_FILE,JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify(result));
}finally{await browser.close();}
