// Native coordinate touch input, fixture API/WS and fake microphone only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {chromium} from '@playwright/test';
import {installMobileChromeFixture} from './mobileChromeFixture.mjs';
const base=process.env.QA_BASE_URL??'http://127.0.0.1:4574',user=process.env.QA_USER_ID;
if(!user)throw Error('Explicit QA_USER_ID required');
const browser=await chromium.launch({...(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{}),args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const reports=[],errors=[],drafted=Boolean(process.env.QA_DRAFT);
try{
 const cases=process.env.QA_QUICK?[{width:393,theme:'light',eligible:true}]:[393,360].flatMap(width=>['light','dark'].flatMap(theme=>[false,true].map(eligible=>({width,theme,eligible}))));
 for(const {width,theme,eligible} of cases){
  const context=await browser.newContext({viewport:{width,height:852},isMobile:true,hasTouch:true,permissions:['microphone'],serviceWorkers:'block'});
  if(process.env.QA_SESSION_SECRET_FILE){const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim(),p=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');await context.addCookies([{name:'codex_remote_session_4575',value:p+'.'+createHmac('sha256',secret).update(p).digest('base64url'),url:base}]);}
  await installMobileChromeFixture(context,user);
  await context.route(/\/prediction(?:\?|$)/,r=>r.fulfill({json:{data:{sourceTurnId:'mobile-turn',eligible,text:eligible?'胶囊预测发送测试':null}}}));
  await context.route('**/api/speech/**',r=>r.fulfill({json:{id:'fixture-speech',combinedTail:true}}));
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/?project=mobile-project&thread=mobile-thread`);await page.getByText('检查手机左栏、正文和右栏。',{exact:true}).waitFor();
  await page.locator('.threadList').evaluate(e=>{if(!e.classList.contains('collapsed'))e.querySelector('.v2SidebarToggle')?.click();});
  await page.evaluate(t=>{document.documentElement.dataset.theme=t;(document.activeElement instanceof HTMLElement)&&document.activeElement.blur();},theme);
  const composer=page.locator('.conversation>.composer'),plus=composer.locator('.v2ComposerPlus'),voice=composer.locator('.voiceButton'),send=composer.locator('.sendButton');
  if(drafted){const editor=composer.locator('[contenteditable=true]').first();await editor.fill('草稿直接发送测试');await editor.evaluate(e=>e.blur());}
  const cdp=await context.newCDPSession(page);
  const tap=async control=>{
   const before=await control.boundingBox();assert.ok(before);const x=before.x+before.width/2,y=before.y+before.height/2;
   const hit=await control.evaluate((e,{x,y})=>e.contains(document.elementFromPoint(x,y)),{x,y});assert.ok(hit,'The glass must not intercept the visible button');
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});await page.waitForTimeout(120);
   const during=await control.boundingBox();
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   if(process.env.QA_ASSERT_STABLE)assert.ok(Math.abs(before.x-during.x)<2&&Math.abs(before.y-during.y)<2,'The pressed capsule button must not move before release');
   return{before,during};
  };
  await page.waitForTimeout(1100);assert.ok((await composer.boundingBox()).height<=56,'Start from the actual idle capsule, not an editor-focused fixture');
  const plusTouch=await tap(plus);await page.locator('#v2PlusMenu').waitFor();await page.waitForTimeout(400);
  await page.locator('.mobileHeaderTitle').tap();await page.locator('#v2PlusMenu').waitFor({state:'hidden'});await page.waitForTimeout(600);
  assert.ok((await composer.boundingBox()).height<=56);
  const voiceTouch=await tap(voice);await composer.locator('.voiceButton.recording').waitFor();
  await composer.getByRole('button',{name:'取消语音输入',exact:true}).tap();await composer.locator('.voiceButton.idle').waitFor();await page.waitForTimeout(600);
  assert.ok((await composer.boundingBox()).height<=56);
  if(eligible||drafted){await page.waitForFunction(()=>!document.querySelector('.conversation>.composer .sendButton')?.disabled);await page.evaluate(()=>{const socket=window.mobileQaSocket,original=socket.send;socket.send=function(raw){const message=JSON.parse(raw);if(message.type==='turn.start')window.qaCapsulePrompt=message.prompt;original.call(this,raw);};});await tap(send);await page.waitForFunction(()=>window.mobileQaSocket.requests.includes('turn.start'));await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>t==='turn.start').length),1,'A capsule tap must submit exactly once');assert.equal(await page.evaluate(()=>window.qaCapsulePrompt),drafted?'草稿直接发送测试':'胶囊预测发送测试');}
  else{assert.equal(await send.isDisabled(),true,'An empty message without a prediction must remain unsendable');assert.equal(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>t==='turn.start').length),0);}
  reports.push({width,theme,eligible,drafted,plusTouch,voiceTouch,fakeMicrophoneStarted:true,send:eligible||drafted?'once':'empty-disabled',productionWrites:0});console.log(JSON.stringify({passed:reports.at(-1)}));await context.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({reports,errors,productionWrites:0}));
}finally{await browser.close();}
