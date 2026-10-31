// Record every paint boundary while fake older pages are prepended.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {chromium} from '@playwright/test';
import {installMobileChromeFixture} from './mobileChromeFixture.mjs';
const user=process.env.QA_USER_ID,base=process.env.QA_BASE_URL??'http://127.0.0.1:4574';
if(!user)throw Error('Explicit QA_USER_ID required');
const browser=await chromium.launch(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{}),reports=[],errors=[];
try{
 for(const width of (process.env.QA_QUICK?[393]:[393,1280])){
  const c=await browser.newContext({viewport:{width,height:852},isMobile:width<720,hasTouch:width<720,serviceWorkers:'block'});
  if(process.env.QA_SESSION_SECRET_FILE){const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim(),p=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');await c.addCookies([{name:'codex_remote_session_4575',value:p+'.'+createHmac('sha256',secret).update(p).digest('base64url'),url:base}]);}
  await installMobileChromeFixture(c,user);
  if(process.env.QA_DELAY_ROW_MEASURE)await c.addInitScript(()=>{
   const Native=ResizeObserver;
   window.ResizeObserver=class extends Native{constructor(callback){super((entries,observer)=>{
    if(entries.some(e=>e.target.classList?.contains('virtualConversationRow')))setTimeout(()=>callback(entries,observer),80);
    else callback(entries,observer);
   });}};
  });
  const turn=i=>({id:`history-${i}`,status:'completed',items:[{id:`user-${i}`,type:'userMessage',text:`长历史问题 ${i}`,timelineAt:new Date(1600000000000+i*2000).toISOString()},{id:`answer-${i}`,type:'agentMessage',text:('长历史正文，不应遮住相邻消息。 History pagination.\n\n').repeat(20+i%4*8),completed:true,timelineAt:new Date(1600000000000+i*2000+1000).toISOString()}]});
  const make=(start,end)=>({id:'mobile-thread',name:'分页帧级隔离验收',cwd:'/fixture',createdAt:1,updatedAt:1,status:'active',configuredModel:'gpt-6.1-sol',turns:Array.from({length:end-start},(_,i)=>turn(start+i))});
  await c.route(/\/api\/projects\/mobile-project\/threads(?:\?|$)/,r=>r.fulfill({json:{data:[make(40,60)]}}));
  let loads=0;
  await c.route(/\/api\/threads\/mobile-thread(?:\?|$)/,async r=>{
   const u=new URL(r.request().url()),older=!!u.searchParams.get('cursor')||Number(u.searchParams.get('before'))>0;
   const stage=older?Math.min(++loads,2):0;
   if(older)await new Promise(resolve=>setTimeout(resolve,150));
   if(older)await page.evaluate(stage=>{
    const viewport=document.querySelector('.messages').getBoundingClientRect();
    const target=[...document.querySelectorAll('[data-message-key]:not(.kind-tool)')].find(n=>{const r=n.getBoundingClientRect();return r.top>=viewport.top&&r.top<viewport.bottom;});
    (window.qaPageAnchors??={})[stage]=target?{key:target.dataset.messageKey,offset:target.getBoundingClientRect().top-viewport.top}:null;
   },stage);
   await r.fulfill({json:{thread:stage===0?make(40,60):stage===1?make(20,40):make(0,20),history:{totalItems:120,returnedItems:40,before:stage*40,nextBefore:(stage+1)*40,hasOlder:stage<2,nextCursor:stage<2?`older-${stage+1}`:null}}});
   await page.evaluate(stage=>{window.qaHistoryStage=stage;},stage).catch(()=>{});
  });
  const page=await c.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?project=mobile-project&thread=mobile-thread');await page.locator('.virtualConversationVirtualMode').waitFor();
  if(width<720)await page.locator('.threadList').evaluate(e=>{if(!e.classList.contains('collapsed'))e.querySelector('.v2SidebarToggle')?.click();});
  await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(600);
  await page.evaluate(()=>{
   window.prependFrames={running:true,frames:0,overlaps:[]};
   const sample=()=>{
    const state=window.prependFrames,viewport=document.querySelector('.messages').getBoundingClientRect();state.frames++;
    const rows=[...document.querySelectorAll('.virtualConversationRow')].map(e=>({key:e.dataset.rowKey,rect:e.getBoundingClientRect()})).filter(e=>e.rect.bottom>viewport.top&&e.rect.top<viewport.bottom).sort((a,b)=>a.rect.top-b.rect.top);
    for(let i=1;i<rows.length;i++)if(rows[i-1].rect.bottom>rows[i].rect.top+1)state.overlaps.push({frame:state.frames,previous:rows[i-1].key,next:rows[i].key,pixels:rows[i-1].rect.bottom-rows[i].rect.top});
    if(state.running)requestAnimationFrame(sample);
   };requestAnimationFrame(sample);
  });
  for(let i=0;i<2;i++){
   await page.locator('.messages').hover();await page.mouse.wheel(0,-100);await page.waitForTimeout(100);
   await page.locator('.messages').evaluate(e=>{e.scrollTop=70;});await page.locator('.messages').hover();await page.mouse.wheel(0,-300);
   try{await page.waitForFunction(expected=>window.qaHistoryStage>=expected,i+1,{timeout:5000});}catch(e){console.log(JSON.stringify({loads,stage:i,debug:await page.evaluate(()=>({stage:window.qaHistoryStage,scroll:document.querySelector('.messages').scrollTop,text:document.querySelector('.messages').textContent.slice(0,200),body:document.body.innerText.slice(-1000)}))}));throw e;}
   await page.waitForTimeout(1400);
   const anchor=await page.evaluate(stage=>{const a=window.qaPageAnchors?.[stage];if(!a)return null;const node=[...document.querySelectorAll('[data-message-key]')].find(n=>n.dataset.messageKey===a.key);return{...a,found:!!node,drift:node?node.getBoundingClientRect().top-document.querySelector('.messages').getBoundingClientRect().top-a.offset:null};},i+1);
   if(process.env.QA_ASSERT_NO_OVERLAP&&anchor)assert.ok(anchor.found&&Math.abs(anchor.drift)<3,'The visible message anchor must remain fixed: '+JSON.stringify(anchor));
  }
  const result=await page.evaluate(()=>{window.prependFrames.running=false;return window.prependFrames;});
  if(process.env.QA_ASSERT_NO_OVERLAP)assert.deepEqual(result.overlaps,[],'No painted frame may put new historical rows over existing text');
  assert.deepEqual(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>/^turn\.(start|interrupt)$/.test(t))),[]);
  reports.push({width,loads,...result,productionWrites:0});console.log(JSON.stringify(reports.at(-1)));await c.close();
 }
 assert.deepEqual(errors,[]);const result={at:new Date().toISOString(),reports,errors,productionWrites:0};if(process.env.QA_RESULT_FILE)await fs.writeFile(process.env.QA_RESULT_FILE,JSON.stringify(result,null,2),{mode:0o600});
}finally{await browser.close();}
