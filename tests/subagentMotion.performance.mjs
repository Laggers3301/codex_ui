// Production static assets, real React components, fully simulated APIs/WS.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
import { installMobileChromeFixture } from './mobileChromeFixture.mjs';

const base=process.env.QA_BASE_URL??'http://127.0.0.1:4574',user=process.env.QA_USER_ID;
if(!user)throw Error('Explicit QA_USER_ID required');
const browser=await chromium.launch(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{});
const reports=[],errors=[];
const toolsMode=Boolean(process.env.QA_MOTION_TOOLS);
try {
 if(process.env.QA_SCREENSHOT_DIR)await fs.mkdir(process.env.QA_SCREENSHOT_DIR,{recursive:true,mode:0o700});
 for(const width of (process.env.QA_QUICK?[393]:[393,1280]))for(const cpuRate of (process.env.QA_QUICK?[4]:[1,4])) {
  const context=await browser.newContext({viewport:{width,height:900},isMobile:width<720,hasTouch:width<720,serviceWorkers:'block'});
  if(process.env.QA_SESSION_SECRET_FILE){
   const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim();
   const payload=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');
   await context.addCookies([{name:'codex_remote_session_4575',value:payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url'),url:base}]);
  }
  await installMobileChromeFixture(context,user);
  await context.addInitScript(()=>{
   window.motionBench={resizes:0,rects:0,scrolls:0};
   const Native=ResizeObserver;
   window.ResizeObserver=class extends Native{constructor(callback){super((entries,observer)=>{window.motionBench.resizes++;callback(entries,observer);});}};
   const rect=Element.prototype.getBoundingClientRect;
   Element.prototype.getBoundingClientRect=function(){window.motionBench.rects++;return rect.call(this);};
   const scroll=Element.prototype.scrollTo;
   Element.prototype.scrollTo=function(...args){window.motionBench.scrolls++;return scroll.apply(this,args);};
  });
  const turns=Array.from({length:24},(_,i)=>({id:`history-${i}`,status:'completed',items:[{id:`u-${i}`,type:'userMessage',text:`隔离性能问题 ${i}`},{id:`a-${i}`,type:'agentMessage',text:('已有正文用于测量展开时的背景重排。 Motion performance. ').repeat(12),completed:true}]}));
  const thread={id:'mobile-thread',name:'子代理动效隔离验收',cwd:'/fixture',createdAt:1,updatedAt:1,status:'active',configuredModel:'gpt-6.1-sol',turns:[...turns,{id:'perf-turn',status:'running',items:[{id:'perf-user',type:'userMessage',text:'只测子代理展开，不发送模型请求。'}]}]};
  if(toolsMode)thread.turns.at(-1).items.push(...Array.from({length:30},(_,i)=>({id:`disclosure-${i}`,type:'toolCall',tool:'exec',input:{cmd:`printf fixture-${i}`},output:`isolated output ${i}`,completed:true})));
  const agents=Array.from({length:3},(_,i)=>({id:`agent-${i}`,name:`/root/motion-${i}`,parentThreadId:thread.id,state:'running',model:'gpt-6.1-sol',updatedAt:1}));
  await context.route(/\/api\/threads\/mobile-thread(?:\?|$)/,r=>r.fulfill({json:{thread,history:{totalItems:97,returnedItems:97,before:0,hasOlder:false}}}));
  await context.route(/\/api\/projects\/mobile-project\/threads(?:\?|$)/,r=>r.fulfill({json:{data:[thread]}}));
  await context.route(/\/api\/.*\/subagents(?:\?|$)/,r=>r.fulfill({json:{data:toolsMode?[]:agents,page:{total:toolsMode?0:3,activeCount:toolsMode?0:3,historyCount:0,unknownCount:0,hasMore:false,nextCursor:null}}}));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpuRate});
  await page.goto(`${base}/?project=mobile-project&thread=mobile-thread`);
  await page.getByText('只测子代理展开，不发送模型请求。',{exact:true}).waitFor({state:'attached'});
  if(width<720){
   await page.locator('.threadList').evaluate(e=>{if(!e.classList.contains('collapsed'))e.querySelector('.v2SidebarToggle')?.click();});
   await page.waitForFunction(()=>document.querySelector('.threadList')?.classList.contains('collapsed'));
   await page.locator('.composerRichInput').click();
  }
  const heading=page.locator(toolsMode?'.toolBundle>.messageMeta':'.subagentCurrentActivity>.toolRevealClip>.threadActivityHeading').last();
  await heading.waitFor();await page.waitForTimeout(1000);
  if(process.env.QA_MOTION_NO_GLASS)await page.addStyleTag({content:'.composerLiquidGlass::before{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}.composerOriginalLayer{display:none!important}'});
  const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
  const before=await metric();
  if(process.env.QA_CPU_PROFILE){await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
  if(process.env.QA_TRACE_FILE)await cdp.send('Tracing.start',{categories:'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking',transferMode:'ReturnAsStream'});
  const motion=await page.evaluate(async toolsMode=>{
   const button=toolsMode?[...document.querySelectorAll('.toolBundle>.messageMeta')].at(-1):document.querySelector('.subagentCurrentActivity>.toolRevealClip>.threadActivityHeading');
   const start={...window.motionBench},frames=[],moves=[],longtasks=[];let last=0,done=false;
   const observer=new PerformanceObserver(list=>longtasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask'});
   const frame=now=>{if(last)frames.push(now-last);last=now;if(!done)requestAnimationFrame(frame);};requestAnimationFrame(frame);
   for(let i=0;i<6;i++){
    const composer=toolsMode?button.closest('.toolBundle'):document.querySelector('.conversation>.composer'),before=composer.getBoundingClientRect().height;
    button.click();await new Promise(r=>setTimeout(r,550));
    moves.push({before,after:composer.getBoundingClientRect().height,open:(toolsMode?composer:button).getAttribute('aria-expanded'),rows:document.querySelectorAll(toolsMode?'.toolBundleEntry':'.subagentRows .subagentRow').length});
   }
   done=true;observer.disconnect();frames.sort((a,b)=>a-b);
   return{frames:frames.length,frameP50Ms:frames[Math.floor(frames.length*.5)],frameP95Ms:frames[Math.floor(frames.length*.95)],frameMaxMs:frames.at(-1),framesOver33:frames.filter(x=>x>34).length,longtasks,moves,resizes:window.motionBench.resizes-start.resizes,rects:window.motionBench.rects-start.rects,scrolls:window.motionBench.scrolls-start.scrolls};
  },toolsMode);
  const after=await metric();
  if(process.env.QA_CPU_PROFILE){const {profile}=await cdp.send('Profiler.stop');await fs.writeFile(process.env.QA_CPU_PROFILE,JSON.stringify(profile),{mode:0o600});}
  if(process.env.QA_TRACE_FILE){
   const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');
   const {stream}=await complete;let trace='';for(;;){const part=await cdp.send('IO.read',{handle:stream});trace+=part.data;if(part.eof)break;}await cdp.send('IO.close',{handle:stream});
   await fs.writeFile(process.env.QA_TRACE_FILE,trace,{mode:0o600});
  }
  assert.ok(motion.moves.every((m,i)=>i%2===0?m.after>m.before&&(toolsMode?m.rows>0:m.rows===3):m.after<m.before),'Actual disclosure must expand and collapse');
  if(toolsMode){reports.push({width,cpuRate,toolsMode,motion,styleMs:1000*(after.RecalcStyleDuration-before.RecalcStyleDuration),layoutMs:1000*(after.LayoutDuration-before.LayoutDuration),scriptMs:1000*(after.ScriptDuration-before.ScriptDuration),taskMs:1000*(after.TaskDuration-before.TaskDuration),productionWrites:0});console.log(JSON.stringify(reports.at(-1)));await context.close();continue;}
  const geometry=await page.evaluate(async()=>{
   const composer=document.querySelector('.conversation>.composer'),messages=document.querySelector('.conversationContent>.messages');
   const row=document.querySelector('.conversationTurnRow');row.classList.add('topAnchoredTurn');
   await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   return{composerHeight:composer.getBoundingClientRect().height,reservedPadding:parseFloat(getComputedStyle(messages).paddingBottom),anchoredHeight:parseFloat(row.style.getPropertyValue('--composer-height')),viewportHeight:parseFloat(row.style.getPropertyValue('--messages-viewport-height')),messagesHeight:messages.clientHeight,backdrop:getComputedStyle(composer,'::before').backdropFilter,pipeline:composer.dataset.glassBackdrop,rowsInert:document.querySelector('.subagentRows').closest('.toolReveal').inert,foldedShimmer:getComputedStyle(document.querySelector('.subagentRows .subagentRunningShimmer')).animationPlayState};
  });
  assert.ok(geometry.reservedPadding>=geometry.composerHeight,'Last messages must remain reachable above the composer');
  assert.ok(Math.abs(geometry.anchoredHeight-geometry.composerHeight)<1);
  assert.equal(geometry.viewportHeight,geometry.messagesHeight);
  if(!process.env.QA_MOTION_NO_GLASS){assert.ok(geometry.backdrop.includes('blur('),'Real backdrop blur must remain enabled');assert.equal(geometry.pipeline,'svg-backdrop','Chromium must retain real refraction, not just a border');}
  assert.equal(geometry.rowsInert,true,'Retained closed rows must not be interactive');
  assert.equal(geometry.foldedShimmer,'paused','Hidden retained rows must not keep painting shimmer');
  if(process.env.QA_SCREENSHOT_DIR){
   await heading.click();await page.waitForTimeout(600);
   await page.screenshot({path:path.join(process.env.QA_SCREENSHOT_DIR,`${width}-${cpuRate}-expanded.png`)});
  }
  assert.deepEqual(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>/^turn\.(start|interrupt)$|^turn\.queue\.(?!list$)|^thread\.create$/.test(t))),[]);
  const report={width,cpuRate,noGlass:!!process.env.QA_MOTION_NO_GLASS,motion,geometry,layoutCount:after.LayoutCount-before.LayoutCount,styleCount:after.RecalcStyleCount-before.RecalcStyleCount,layoutMs:1000*(after.LayoutDuration-before.LayoutDuration),styleMs:1000*(after.RecalcStyleDuration-before.RecalcStyleDuration),scriptMs:1000*(after.ScriptDuration-before.ScriptDuration),taskMs:1000*(after.TaskDuration-before.TaskDuration),productionWrites:0};
  reports.push(report);console.log(JSON.stringify(report));await context.close();
 }
 assert.deepEqual(errors,[]);
 const result={at:new Date().toISOString(),reports,errors,productionWrites:0};
 if(process.env.QA_RESULT_FILE)await fs.writeFile(process.env.QA_RESULT_FILE,JSON.stringify(result,null,2),{mode:0o600});
} finally {await browser.close();}
