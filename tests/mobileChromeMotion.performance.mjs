// VisualViewport resize is simulated: this is NOT a physical iOS keyboard test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {chromium} from '@playwright/test';
import {installMobileChromeFixture} from './mobileChromeFixture.mjs';
const user=process.env.QA_USER_ID,base=process.env.QA_BASE_URL??'http://127.0.0.1:4574';if(!user)throw Error('Explicit QA_USER_ID required');
const browser=await chromium.launch(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{}),reports=[],errors=[];
try{
 for(const action of (process.env.QA_ACTION?Array.from({length:Number(process.env.QA_REPEATS??1)},()=>process.env.QA_ACTION):['header','plus','keyboard'])){
  const c=await browser.newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim(),p=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');await c.addCookies([{name:'codex_remote_session_4575',value:p+'.'+createHmac('sha256',secret).update(p).digest('base64url'),url:base}]);
  await installMobileChromeFixture(c,user);
  await c.addInitScript(()=>{const viewport=new EventTarget();Object.assign(viewport,{width:393,height:852,offsetTop:0,offsetLeft:0,pageTop:0,pageLeft:0,scale:1});Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});window.qaKeyboard=height=>{viewport.height=height;viewport.dispatchEvent(new Event('resize'));};});
  await c.addInitScript(()=>{window.qaRootMetricWrites=[];const set=CSSStyleDeclaration.prototype.setProperty;CSSStyleDeclaration.prototype.setProperty=function(name,value,...args){if(this===document.documentElement.style&&name==='--v2-sidebar-width')window.qaRootMetricWrites.push(value);return set.call(this,name,value,...args);};});
  await c.addInitScript(()=>{window.qaMenuHeightReads=0;const descriptor=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'offsetHeight');Object.defineProperty(HTMLElement.prototype,'offsetHeight',{...descriptor,get(){if(this.id==='v2PlusMenu')window.qaMenuHeightReads++;return descriptor.get.call(this);}});});
  const turns=Array.from({length:24},(_,i)=>({id:`motion-${i}`,status:'completed',items:[{id:`u-${i}`,type:'userMessage',text:`假数据问题${i}`},{id:`a-${i}`,type:'agentMessage',text:('隔离性能正文，保持真实历史规模。 Rendering motion. ').repeat(15),completed:true}]}));
  const thread={id:'mobile-thread',name:'手机展开动画性能',cwd:'/fixture',createdAt:1,updatedAt:1,status:'active',configuredModel:'gpt-6.1-sol',turns};
  await c.route(/\/api\/threads\/mobile-thread(?:\?|$)/,r=>r.fulfill({json:{thread,history:{totalItems:48,returnedItems:48,before:0,nextBefore:48,hasOlder:false}}}));
  await c.route(/\/api\/projects\/mobile-project\/threads(?:\?|$)/,r=>r.fulfill({json:{data:[thread]}}));
  const page=await c.newPage();page.on('pageerror',e=>errors.push(e.message));const dev=await c.newCDPSession(page);await dev.send('Emulation.setCPUThrottlingRate',{rate:4});await dev.send('Performance.enable');
  await page.goto(base+'/?project=mobile-project&thread=mobile-thread');await page.locator('.composerRichInput').waitFor();await page.locator('.threadList').evaluate(e=>{if(!e.classList.contains('collapsed'))e.querySelector('.v2SidebarToggle')?.click();});await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(800);
  const metrics=async()=>Object.fromEntries((await dev.send('Performance.getMetrics')).metrics.map(e=>[e.name,e.value])),before=await metrics();
  if(process.env.QA_TRACE_FILE)await dev.send('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking',transferMode:'ReturnAsStream'});
  const motion=await page.evaluate(async action=>{
   const frames=[],tasks=[],rootBefore=window.qaRootMetricWrites.length,readsBefore=window.qaMenuHeightReads;let last=0,done=false;const frame=n=>{if(last)frames.push(n-last);last=n;if(!done)requestAnimationFrame(frame);};requestAnimationFrame(frame);const o=new PerformanceObserver(l=>tasks.push(...l.getEntries().map(e=>e.duration)));o.observe({type:'longtask'});const started=performance.now();
   if(action==='header')document.querySelector('.mobileHeaderTitle').click();
   if(action==='plus')document.querySelector('.v2ComposerPlus').click();
   if(action==='keyboard'){document.querySelector('.composerRichInput').focus();for(let i=1;i<=16;i++){window.qaKeyboard(852-Math.round(i/16*330));await new Promise(r=>setTimeout(r,16));}}
   await new Promise(r=>setTimeout(r,650));done=true;o.disconnect();frames.sort((a,b)=>a-b);
   const p=document.querySelector('.messageMarkdown p');
   return{duration:performance.now()-started,frames:frames.length,p95:frames[Math.floor(frames.length*.95)],max:frames.at(-1),over34:frames.filter(n=>n>34).length,longtasks:tasks,rootSidebarWrites:window.qaRootMetricWrites.slice(rootBefore),menuHeightReads:window.qaMenuHeightReads-readsBefore,scopedViewport:{paragraph:p?getComputedStyle(p).getPropertyValue('--phone-viewport-height'):null,composer:document.querySelector('.composer').style.getPropertyValue('--phone-viewport-height')},composerHeight:document.querySelector('.composer').getBoundingClientRect().height,documentHeight:document.documentElement.getBoundingClientRect().height,editorText:document.querySelector('.composerRichInput').textContent};
  },action);
  const after=await metrics();
  if(process.env.QA_TRACE_FILE){const complete=new Promise(resolve=>dev.once('Tracing.tracingComplete',resolve));await dev.send('Tracing.end');const {stream}=await complete;let result='';for(;;){const part=await dev.send('IO.read',{handle:stream});result+=part.data;if(part.eof)break;}await dev.send('IO.close',{handle:stream});await fs.writeFile(process.env.QA_TRACE_FILE,result,{mode:0o600});}
  if(action==='header')assert.equal(await page.locator('.topbar').getAttribute('data-mobile-controls'),'visible');if(action==='plus'){assert.equal(await page.locator('#v2PlusMenu').isVisible(),true);assert.equal(motion.menuHeightReads,0,'Mobile menu positioning must not synchronously read its height');}if(action==='keyboard'){assert.ok(Math.abs(motion.documentHeight-522)<2);assert.equal(motion.editorText,'');}
  assert.deepEqual(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>/^turn\.(start|interrupt)$/.test(t))),[]);
  reports.push({action,cpuRate:4,motion,styleMs:1000*(after.RecalcStyleDuration-before.RecalcStyleDuration),layoutMs:1000*(after.LayoutDuration-before.LayoutDuration),scriptMs:1000*(after.ScriptDuration-before.ScriptDuration),productionWrites:0});console.log(JSON.stringify(reports.at(-1)));await c.close();
 }
 assert.deepEqual(errors,[]);const result={at:new Date().toISOString(),simulatedKeyboard:true,reports,errors,productionWrites:0};if(process.env.QA_RESULT_FILE)await fs.writeFile(process.env.QA_RESULT_FILE,JSON.stringify(result,null,2),{mode:0o600});
}finally{await browser.close();}
