// Fully simulated API/WS. No model requests or production conversation writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
import { installMobileChromeFixture } from './mobileChromeFixture.mjs';
const user=process.env.QA_USER_ID,base=process.env.QA_BASE_URL??'http://127.0.0.1:4574';
if(!user)throw Error('Explicit QA_USER_ID required');
const browser=await chromium.launch(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{}),reports=[],errors=[];
const prediction=['预测首行应该完整显示',...Array.from({length:8},(_,i)=>`这是预测建议第${i+1}行，请仔细阅读。`),'预测最后一行也可以读到'].join('\n');
async function context(width){
 const c=await browser.newContext({viewport:{width,height:852},isMobile:width<720,hasTouch:width<720,serviceWorkers:'block'});
 if(process.env.QA_SESSION_SECRET_FILE){const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim(),p=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');await c.addCookies([{name:'codex_remote_session_4575',value:p+'.'+createHmac('sha256',secret).update(p).digest('base64url'),url:base}]);}
 await installMobileChromeFixture(c,user);return c;
}
try{
 if(process.env.QA_SCREENSHOT_DIR)await fs.mkdir(process.env.QA_SCREENSHOT_DIR,{recursive:true,mode:0o700});
 for(const {width,theme,long} of (process.env.QA_QUICK?[{width:393,theme:'light',long:false}]:[393,360,1280].flatMap(width=>['light','dark'].map(theme=>({width,theme,long:false}))).concat([{width:393,theme:'light',long:true}]))){
  const c=await context(width),text=long?prediction+'\n'+('超长预测仍可滚动查看，不会丢掉后半段。\n'.repeat(70))+'完整预测结尾':prediction;
  await c.route(/\/prediction(?:\?|$)/,r=>r.fulfill({json:{data:{sourceTurnId:'mobile-turn',eligible:true,text}}}));
  const page=await c.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?project=mobile-project&thread=mobile-thread');await page.locator('.composerPredictionGhost').waitFor();
  if(width<720)await page.locator('.threadList').evaluate(e=>{if(!e.classList.contains('collapsed'))e.querySelector('.v2SidebarToggle')?.click();});
  await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.activeElement?.blur();},theme);await page.waitForTimeout(700);
  const composer=page.locator('.conversation>.composer'),editor=composer.locator('[contenteditable=true]').first(),ghost=composer.locator('.composerPredictionGhost');
  const compact=await ghost.evaluate(g=>{const shell=g.closest('.composerRichEditor'),r=document.createRange();r.setStart(g.firstChild,0);r.setEnd(g.firstChild,8);const a=r.getBoundingClientRect(),b=shell.getBoundingClientRect();return{height:g.closest('.composer').getBoundingClientRect().height,lineTop:a.top-b.top,lineBottom:a.bottom-b.top,viewport:b.height,padding:getComputedStyle(g).paddingTop,ghostMask:getComputedStyle(g).maskImage,shellMask:getComputedStyle(shell).maskImage,position:getComputedStyle(g).position};});
  assert.equal((await editor.innerText()).trim(),'','A prediction is not accepted by loading the page');
  if(width<720){assert.ok(compact.height<=56);assert.ok(compact.lineTop>=-1&&compact.lineBottom<=compact.viewport+1,'First prediction line must not be clipped or vertically faded');assert.equal(compact.padding,'0px');assert.equal(compact.ghostMask,'none');assert.ok(compact.shellMask.includes('to right'));}
  else{assert.equal(compact.position,'absolute','Desktop prediction layout stays unchanged');}
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.QA_SCREENSHOT_DIR,`${width}-${theme}-${long?'long':'normal'}-compact.png`)});
  await editor.click();await page.waitForTimeout(600);
  assert.equal((await editor.innerText()).trim(),'','Focusing must not silently accept the prediction');
  const expanded=await ghost.evaluate(g=>{const shell=g.closest('.composerRichEditor');return{height:shell.clientHeight,contentHeight:shell.scrollHeight,ghostHeight:g.getBoundingClientRect().height,position:getComputedStyle(g).position,overflow:getComputedStyle(shell).overflowY,composerHeight:g.closest('.composer').getBoundingClientRect().height};});
  if(width<720){assert.equal(expanded.position,'relative');assert.ok(expanded.height>190,'Expanded predictions must grow beyond the old fixed editor height');assert.equal(expanded.overflow,'auto');if(!long)assert.ok(expanded.contentHeight<=expanded.height+2,'A normal multiline prediction fits in full');
   if(long){assert.ok(expanded.contentHeight>expanded.height);await ghost.evaluate(g=>{const s=g.closest('.composerRichEditor');s.scrollTop=s.scrollHeight;});await page.waitForTimeout(150);const end=await ghost.evaluate(g=>{const s=g.closest('.composerRichEditor'),t=g.firstChild,r=document.createRange();r.setStart(t,t.length-8);r.setEnd(t,t.length);const a=r.getBoundingClientRect(),b=s.getBoundingClientRect();return{top:a.top-b.top,bottom:a.bottom-b.top,height:b.height};});assert.ok(end.top>=0&&end.bottom<=end.height+1,'Very long prediction ending must remain reachable');}
  }
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.QA_SCREENSHOT_DIR,`${width}-${theme}-${long?'long':'normal'}-expanded.png`)});
  if(width<720){await editor.fill('我自己的问题');await page.waitForTimeout(300);await ghost.waitFor({state:'detached'});assert.equal(await editor.innerText(),'我自己的问题');await editor.evaluate(e=>e.blur());await page.waitForTimeout(450);assert.ok((await composer.boundingBox()).height<=56);}
  else{await page.keyboard.press('Tab');await ghost.waitFor({state:'detached'});assert.ok((await editor.innerText()).includes('预测最后一行也可以读到'));}
  assert.deepEqual(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>/^turn\.(start|interrupt)$/.test(t))),[]);
  reports.push({width,theme,long,compact,expanded,productionWrites:0});console.log(JSON.stringify({passed:reports.at(-1)}));await c.close();
 }
 for(const theme of (process.env.QA_QUICK?['light']:['light','dark'])){
  const c=await context(393);
  const thread={id:'mobile-thread',name:'排队胶囊隔离验收',cwd:'/fixture',createdAt:1,updatedAt:1,status:'active',configuredModel:'gpt-6.1-sol',turns:[{id:'mobile-turn',status:'running',items:[{id:'q-user',type:'userMessage',text:'正在进行中的问题'}]}]};
  await c.route(/\/api\/threads\/mobile-thread(?:\?|$)/,r=>r.fulfill({json:{thread,history:{totalItems:1,returnedItems:1,before:0,hasOlder:false}}}));
  await c.route(/\/api\/projects\/mobile-project\/threads(?:\?|$)/,r=>r.fulfill({json:{data:[thread]}}));
  const page=await c.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?project=mobile-project&thread=mobile-thread');await page.getByText('正在进行中的问题',{exact:true}).waitFor();
  await page.locator('.threadList').evaluate(e=>{if(!e.classList.contains('collapsed'))e.querySelector('.v2SidebarToggle')?.click();});
  await page.evaluate(theme=>{
   document.documentElement.dataset.theme=theme;document.activeElement?.blur();
   const socket=window.mobileQaSocket,original=socket.send;
   socket.emit({type:'live.state',data:{activeTurns:[{threadId:'mobile-thread',turnId:'mobile-turn',status:'running',startedAt:'2020-01-01T00:00:00Z',updatedAt:'2020-01-01T00:00:01Z'}],agentMessages:[],reasoningMessages:[],toolItems:[]}});
   socket.queue=[{id:'q-1',input:[{type:'text',text:'第一条排队问题'}]},{id:'q-2',input:[{type:'text',text:'第二条排队问题'}]}];
   socket.send=function(raw){const x=JSON.parse(raw);if(!x.type.startsWith('turn.queue.'))return original.call(this,raw);this.requests.push(x.type);
    if(x.type==='turn.queue.update')this.queue=this.queue.map(q=>q.id===x.queuedSubmissionId?{...q,input:[{type:'text',text:x.prompt}]}:q);
    if(x.type==='turn.queue.delete'||x.type==='turn.queue.steer')this.queue=this.queue.filter(q=>q.id!==x.queuedSubmissionId);
    setTimeout(()=>this.emit({type:'ack',requestId:x.requestId,ok:true,data:{threadId:'mobile-thread',data:x.type==='turn.queue.list'?this.queue:undefined}}),30);
   };
   socket.emit({type:'ack',requestId:'queue-list-fixture',ok:true,data:{threadId:'mobile-thread',data:socket.queue}});
  },theme);await page.waitForTimeout(800);
  const composer=page.locator('.conversation>.composer'),strip=composer.locator('.queuedSubmissionStrip');
  await strip.waitFor();assert.ok((await composer.boundingBox()).height<=56,'A real queued message must not force open the capsule');
  const box=await strip.boundingBox(),capsule=await composer.boundingBox();assert.ok(box.y+box.height<capsule.y,'Queued messages stay in a separate visible row above the capsule');
  assert.ok((await strip.evaluate(e=>getComputedStyle(e).backdropFilter)).includes('blur('));
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.QA_SCREENSHOT_DIR,`393-${theme}-queued-capsule.png`)});
  await strip.getByRole('button',{name:'更多排队操作',exact:true}).tap();await strip.getByRole('button',{name:'编辑消息',exact:true}).tap();
  await strip.locator('.queuedEditInput').fill('编辑后的排队问题');await strip.getByRole('button',{name:'保存',exact:true}).tap();await strip.getByText('编辑后的排队问题',{exact:true}).waitFor();
  await page.locator('.mobileHeaderTitle').tap();await page.waitForTimeout(500);
  assert.ok((await composer.boundingBox()).height<=56);await strip.getByRole('button',{name:'调整方向',exact:true}).tap();
  await strip.getByText('第二条排队问题',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>t==='turn.queue.steer').length),1);
  assert.equal(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>t==='turn.start'||t==='turn.interrupt').length),0,'Steering must not change into a new turn or interrupt');
  await strip.getByRole('button',{name:'移除排队消息',exact:true}).tap();await strip.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.mobileQaSocket.queue.length),0);
  reports.push({width:393,theme,queueVisibleAboveCapsule:true,editPreserved:true,steerOnce:true,deletePreserved:true,productionWrites:0});console.log(JSON.stringify({passed:reports.at(-1)}));await c.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({reports,errors,productionWrites:0}));
}finally{await browser.close();}
