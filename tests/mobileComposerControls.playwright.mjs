// Only static assets reach the local site. All API/WS traffic is a fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
import { installMobileChromeFixture } from './mobileChromeFixture.mjs';

const base=process.env.QA_BASE_URL??'http://127.0.0.1:4574';
const user=process.env.QA_USER_ID;
if(!user)throw Error('Explicit QA_USER_ID required');
const browser=await chromium.launch(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{});
const reports=[],errors=[];
const draft='保留未发送的草稿 We’re testing 123\n第二行也不能丢。';
try {
  if(process.env.QA_SCREENSHOT_DIR)await fs.mkdir(process.env.QA_SCREENSHOT_DIR,{recursive:true,mode:0o700});
  const cases=process.env.QA_QUICK?[{width:393,theme:'light',fallback:true}]:
    [false,true].flatMap(fallback=>[393,360].flatMap(width=>['light','dark'].map(theme=>({width,theme,fallback}))));
  if(process.env.QA_DESKTOP_ONLY&&process.env.QA_MOBILE_ONLY)throw Error('Choose either mobile-only or desktop-only');
  if(process.env.QA_DESKTOP_ONLY)cases.length=0;
  if(!process.env.QA_MOBILE_ONLY)cases.push({width:1280,theme:'light',fallback:false},{width:1280,theme:'dark',fallback:false});
  for(const {width,theme,fallback} of cases){
    const mobile=width<=720;
    const context=await browser.newContext({viewport:{width,height:852},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',...(fallback?{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'}:{})});
    if(process.env.QA_SESSION_SECRET_FILE){
      const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim();
      const value=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');
      await context.addCookies([{name:'codex_remote_session_4575',value:value+'.'+createHmac('sha256',secret).update(value).digest('base64url'),url:base}]);
    }
    await installMobileChromeFixture(context,user);
    await context.route('**/api/models',route=>route.fulfill({json:{data:[
      {id:'sol',label:'gpt-6.1-sol medium',model:'gpt-6.1-sol',effort:'medium'},
      {id:'long-sol',label:'gpt-6.1-sol · Extra high reasoning / 长型号名称换行检查',model:'gpt-6.1-sol',effort:'xhigh'}
    ]}}));
    await context.route('**/api/projects',route=>route.fulfill({json:{threadContextFeatureEnabled:true,projectRoot:'/fixture',data:[{id:'mobile-project',name:'移动界面验收',rootPath:'/fixture',userId:user,defaultModel:'gpt-6.1-sol',defaultSandbox:'danger-full-access',defaultApprovalPolicy:'never'}]}}));
    await context.route('**/context',route=>route.fulfill({json:{data:{threadId:'mobile-thread',usedTokens:100,contextWindow:500000,usedPercent:0.02,compactedAt:[],pin:{text:''},config:{profile:'default',contextWindow:null,autoCompactTokenLimit:null}}}}));
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
    await page.goto(`${base}/?project=mobile-project&thread=mobile-thread`);
    await page.getByText('检查手机左栏、正文和右栏。',{exact:true}).waitFor();
    if(mobile){
      const sidebar=page.locator('.threadList');
      if(!await sidebar.evaluate(e=>e.classList.contains('collapsed')))await sidebar.locator('.v2SidebarToggle').click();
      await page.waitForFunction(()=>document.querySelector('.threadList').classList.contains('collapsed'));
    }
    await page.evaluate(mode=>{document.documentElement.dataset.theme=mode;},theme);
    const composer=page.locator('.conversation>.composer');
    const editor=composer.locator('[contenteditable="true"]').first();
    // ProseMirror's empty <p><br></p> can have innerText="\n", but no text.
    const readDraft=()=>editor.evaluate(element=>element.textContent?element.innerText:'');
    const plus=composer.locator('.v2ComposerPlus');
    const menu=page.locator('#v2PlusMenu');
    async function focusAndDismiss(trigger){
      await editor.focus();await page.waitForTimeout(300);
      if(mobile){await page.setViewportSize({width,height:560});await page.waitForTimeout(50);}
      // iOS button taps may not transfer focus. Do not use locator.click(),
      // which focuses the button and would mask the actual touch-only race.
      await trigger.dispatchEvent('pointerdown',{pointerType:mobile?'touch':'mouse',pointerId:1,button:0,bubbles:true});
      await editor.evaluate(element=>element.blur());
      assert.ok(await trigger.isVisible(),'Control must remain visible until click is delivered');
      await trigger.dispatchEvent('pointerup',{pointerType:mobile?'touch':'mouse',pointerId:1,button:0,bubbles:true});
      await trigger.dispatchEvent('click',{bubbles:true});
      if(mobile)await page.setViewportSize({width,height:852});
      await page.waitForTimeout(650);
    }
    let expectedDraft='';
    for(const text of ['',draft]){
      await editor.fill(text);await page.waitForTimeout(250);
      // Capture the editor's settled paragraph serialization before touching
      // controls; TipTap renders separate paragraphs with two innerText LFs.
      expectedDraft=await readDraft();
      assert.deepEqual(expectedDraft.split(/\n+/),text.split('\n'));
      await focusAndDismiss(plus);
      assert.ok(await menu.isVisible(),'Plus menu must survive keyboard dismissal');
      if(mobile)assert.ok((await composer.boundingBox()).height>60,'An external plus menu must keep its mobile composer expanded after the touch grace period');
      else assert.equal(await composer.getAttribute('data-mobile-plus-menu-open'),null,'Desktop must not install a mobile menu hold');
      const menuBox=await menu.boundingBox();
      assert.ok(menuBox.x>=0&&menuBox.x+menuBox.width<=width+1&&menuBox.y>=0,'Plus menu must fit the viewport');
      assert.equal(await readDraft(),expectedDraft,'Opening plus must preserve the entire draft');
      if(mobile)assert.equal(await editor.evaluate(element=>element===document.activeElement),false,'Plus must dismiss the editor keyboard without losing its draft');
      await editor.evaluate(element=>element.blur());
      if(mobile){await page.setViewportSize({width,height:650});await page.setViewportSize({width,height:852});}
      await page.waitForTimeout(400);
      assert.ok(await menu.isVisible(),'Blur/viewport updates alone must not dismiss plus');
      await page.locator(mobile?'.mobileHeaderTitle':'.topbar .projectTitle').click();await page.waitForTimeout(500);
      assert.equal(await menu.isVisible(),false,'A real outside tap must still close plus');
      assert.equal(await composer.getAttribute('data-mobile-plus-menu-open'),null,'Menu exit must release the mobile hold');
      assert.equal(await readDraft(),expectedDraft);
      if(mobile&& !text)assert.ok((await composer.boundingBox()).height<=56,'Empty composer must collapse after menu exit');

      await focusAndDismiss(composer.locator('.v2ContextStatusButton'));
      const dialog=page.locator('.contextDialog');await dialog.waitFor();
      await dialog.locator('.contextPinEditor textarea').focus();
      await dialog.locator('.contextPinEditor textarea').evaluate(element=>element.blur());
      if(mobile){await page.setViewportSize({width,height:650});await page.setViewportSize({width,height:852});}
      assert.ok(await dialog.isVisible(),'Context dialog must stay open when its keyboard closes');
      assert.equal(await readDraft(),expectedDraft,'Context settings must not replace the chat draft');
      await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
      assert.equal(await readDraft(),expectedDraft);

      const fast=composer.locator('.v2FastModeButton:not(.v2ContextStatusButton)');
      const before=await fast.innerText();
      await focusAndDismiss(fast);
      assert.notEqual(await fast.innerText(),before,'Fast is a toggle, not a menu, and must apply exactly once');
      assert.equal(await readDraft(),expectedDraft,'Fast must not alter the draft');
      await editor.evaluate(element=>element.blur());await page.waitForTimeout(400);
      assert.notEqual(await fast.innerText(),before,'Keyboard dismissal must not undo Fast');
      await focusAndDismiss(fast);
      assert.equal(await fast.innerText(),before,'Fast must toggle back normally');
    }

    await editor.focus();await page.waitForTimeout(300);
    const modelTrigger=composer.locator('.groupedModelPicker>.polishedSelectTrigger');
    await modelTrigger.click();
    const models=composer.locator('.groupedModelMenu');await models.waitFor();
    const category=await models.locator('.groupedModelRow').first().evaluate(e=>({size:getComputedStyle(e).fontSize,weight:getComputedStyle(e).fontWeight}));
    await models.getByRole('button',{name:'GPT',exact:true}).click();
    const option=models.locator('.groupedModelProfile strong').first();await option.waitFor();
    const profile=await option.evaluate(e=>({size:getComputedStyle(e).fontSize,weight:getComputedStyle(e).fontWeight,overflow:e.scrollWidth>e.clientWidth+1}));
    if(mobile)for(const label of await models.locator('.groupedModelProfile strong').evaluateAll(elements=>elements.map(e=>({size:getComputedStyle(e).fontSize,overflow:e.scrollWidth>e.clientWidth+1})))){assert.equal(label.size,'15px');assert.equal(label.overflow,false,'Long model labels must wrap instead of overflowing');}
    if(mobile){assert.deepEqual(category,{size:'15px',weight:'400'});assert.equal(profile.size,'15px');assert.equal(profile.weight,'400');assert.equal(profile.overflow,false);}
    else{assert.deepEqual(category,{size:'12px',weight:'520'});assert.equal(profile.size,'12px');assert.equal(profile.weight,'520');}
    assert.equal(await readDraft(),expectedDraft,'Model navigation must also preserve draft content');
    if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.QA_SCREENSHOT_DIR,`${width}-${theme}-${fallback?'fallback':'default'}-model-type.png`)});
    assert.deepEqual(await page.evaluate(()=>window.mobileQaSocket.requests.filter(type=>/^turn\.(start|interrupt)$|^turn\.queue\.(?!list$)|^thread\.create$/.test(type))),[],'Controls must not send, stop or queue turns (queue.list is read-only)');
    reports.push({width,theme,fallback,emptyAndMultilineDraft:true,plusStable:true,contextStable:true,fastToggles:true,category,profile,productionWrites:0});
    console.log(JSON.stringify({passed:reports.at(-1)}));
    await context.close();
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({cases:reports.length,reports,errors,productionWrites:0}));
}finally{await browser.close();}
