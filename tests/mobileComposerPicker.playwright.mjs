// Production static assets are allowed; every API and WebSocket is a fixture.
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
try {
  if(process.env.QA_SCREENSHOT_DIR)await fs.mkdir(process.env.QA_SCREENSHOT_DIR,{recursive:true,mode:0o700});
  for(const fallback of [false,true])for(const width of [393,360])for(const theme of ['light','dark']) {
    const context=await browser.newContext({viewport:{width,height:852},isMobile:true,hasTouch:true,serviceWorkers:'block',...(fallback?{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'}:{})});
    if(process.env.QA_SESSION_SECRET_FILE){
      const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim();
      const value=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');
      await context.addCookies([{name:'codex_remote_session_4575',value:value+'.'+createHmac('sha256',secret).update(value).digest('base64url'),url:base}]);
    }
    await installMobileChromeFixture(context,user);
    await context.route('**/api/models',route=>route.fulfill({json:{data:[
      {id:'sol',label:'gpt-6.1-sol medium',model:'gpt-6.1-sol',effort:'medium'},
      {id:'terra',label:'gpt-6.1-terra medium',model:'gpt-6.1-terra',effort:'medium'}
    ]}}));
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
    await page.goto(`${base}/?project=mobile-project&thread=mobile-thread`);
    await page.getByText('检查手机左栏、正文和右栏。',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.threadList').classList.contains('collapsed'));
    await page.evaluate(mode=>{document.documentElement.dataset.theme=mode;},theme);
    const editor=page.locator('.conversation>.composer [contenteditable="true"]').first();
    const composer=page.locator('.conversation>.composer');
    const trigger=composer.locator('.groupedModelPicker>.polishedSelectTrigger');
    assert.equal(await page.locator('.queuedSubmissionStrip').count(),0,'This case must exercise an empty, collapsible composer');
    await editor.focus();await page.waitForTimeout(350);
    await page.setViewportSize({width,height:560});await page.waitForTimeout(200);
    // iOS buttons need not retain focus when dismissing the software keyboard.
    // Exercise that exact focus loss between pointerdown and the click.
    await trigger.dispatchEvent('pointerdown',{pointerType:'touch',pointerId:1,button:0,bubbles:true});
    await editor.evaluate(element=>element.blur());await page.waitForTimeout(30);
    assert.ok(await trigger.isVisible(),'Keyboard blur must not collapse/hide the model trigger before click');
    await trigger.dispatchEvent('pointerup',{pointerType:'touch',pointerId:1,button:0,bubbles:true});
    await trigger.click();
    const menu=composer.locator('.groupedModelMenu');await menu.waitFor();
    await page.setViewportSize({width,height:852});await page.waitForTimeout(450);
    assert.ok(await menu.isVisible(),'Model menu must remain visible after keyboard viewport restores');
    const menuBox=await menu.boundingBox();
    assert.ok(menuBox.x>=0&&menuBox.x+menuBox.width<=width+1,'Menu must fit the mobile viewport');
    if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.QA_SCREENSHOT_DIR,`${width}-${theme}-${fallback?'fallback':'default'}-menu.png`)});
    await menu.getByRole('button',{name:'GPT',exact:true}).click();
    await menu.getByRole('option',{name:'gpt-6.1-terra medium',exact:true}).click();
    await page.waitForTimeout(650);
    assert.equal(await trigger.getAttribute('aria-expanded'),'false');
    assert.ok((await trigger.textContent()).includes('gpt-6.1-terra'),'Selected model must actually update the composer');
    await editor.focus();await page.waitForTimeout(350);await trigger.click();await menu.waitFor();
    await page.locator('.mobileHeaderTitle').click();await page.waitForTimeout(700);
    assert.equal(await trigger.getAttribute('aria-expanded'),'false','Outside tap must dismiss an unfocused mobile picker');
    assert.ok((await composer.boundingBox()).height<=56,'Empty composer can collapse again after dismissal');
    const starts=await page.evaluate(()=>window.mobileQaSocket.requests.filter(type=>type==='turn.start'));
    assert.deepEqual(starts,[],'Changing picker state must not send a model turn');
    reports.push({width,theme,fallback,keyboardBlurBeforeClick:true,viewportRestore:true,modelSelected:true,outsideDismiss:true,productionWrites:0});
    await context.close();
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({cases:reports.length,reports,errors,productionWrites:0}));
} finally {await browser.close();}
