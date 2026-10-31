// Native touch/click only; every API and WebSocket is intercepted by fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {chromium} from '@playwright/test';
import {installMobileChromeFixture} from './mobileChromeFixture.mjs';
const base=process.env.QA_BASE_URL??'http://127.0.0.1:4574',user=process.env.QA_USER_ID;
if(!user)throw Error('Explicit QA_USER_ID required');
const browser=await chromium.launch(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{});
const errors=[],reports=[];
try {
  for(const width of [360,393,1280])for(const theme of ['light','dark']) {
    const mobile=width<=720;
    const userAgent=width===393?'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1':width===360?'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36':undefined;
    const context=await browser.newContext({viewport:{width,height:852},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block',...(userAgent?{userAgent}:{})});
    const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim();
    const payload=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');
    await context.addCookies([{name:'codex_remote_session_4575',value:payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url'),url:base}]);
    await installMobileChromeFixture(context,user);
    await context.addInitScript(theme=>localStorage.setItem('codex-web-color-theme',theme),theme);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/?project=mobile-project&thread=mobile-thread');
    const composer=page.locator('.conversation>.composer'),input=composer.locator('.composerRichInput');
    await input.waitFor();
    if(mobile)await page.locator('.threadList').evaluate(e=>{if(!e.classList.contains('collapsed'))e.querySelector('.v2SidebarToggle')?.click();});
    await page.waitForTimeout(700);
    const blur=()=>input.evaluate(e=>e.blur());
    if(mobile) {
      assert.ok((await composer.boundingBox()).height<=56);
      // The wrapper is not editable. A trusted single tap on it must still
      // focus immediately; waiting for a second tap/async RAF is forbidden.
      await page.evaluate(()=>{const e=document.querySelector('.composerRichEditor');e.style.setProperty('padding-inline-end','12px','important');});
      const rect=await composer.locator('.composerRichEditor').boundingBox();
      await page.touchscreen.tap(rect.x+rect.width-4,rect.y+rect.height/2);
      assert.equal(await input.evaluate(e=>document.activeElement===e),true);
      await page.waitForTimeout(350);assert.ok((await composer.boundingBox()).height>60);
      await page.keyboard.insertText('单击就能输入 mixed draft');
      assert.equal(await input.textContent(),'单击就能输入 mixed draft');
      await blur();await page.waitForTimeout(500);
      assert.ok((await composer.boundingBox()).height<=56);
      await composer.locator('.composerRichEditor').evaluate(e=>e.style.removeProperty('padding-inline-end'));
    }
    await composer.locator('.v2ComposerPlus').click();
    const menu=page.locator('#v2PlusMenu');await menu.waitFor();await page.waitForTimeout(400);
    const check=await menu.evaluate(e=>{const r=e.getBoundingClientRect(),v=visualViewport;return{x:r.left,y:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,vw:v?.width??innerWidth,vh:v?.height??innerHeight,top:v?.offsetTop??0,blur:getComputedStyle(e).backdropFilter,animation:getComputedStyle(e).animationName};});
    assert.ok(check.x>=10&&check.right<=check.vw+1&&check.y>=check.top+9&&check.bottom<=check.top+check.vh+1,JSON.stringify(check));
    assert.ok(check.height>100&&check.width>250);
    assert.ok(check.blur.includes('blur('),'Keep real menu backdrop blur');
    assert.notEqual(check.animation,'none','Keep the menu arrival animation');
    if(mobile) {
      assert.equal(await input.textContent(),'单击就能输入 mixed draft');
      // Clicking a control may dismiss the keyboard, not focus the editor.
      assert.equal(await input.evaluate(e=>document.activeElement===e),false);
      await page.setViewportSize({width,height:552});await page.waitForTimeout(450);
      const resized=await menu.boundingBox(),anchor=await composer.locator('.v2ComposerPlus').boundingBox();
      assert.ok(resized.y>=9&&resized.y+resized.height<=552,'Keep the menu within a keyboard-sized viewport');
      assert.ok(Math.abs(resized.y+resized.height-(anchor.y-8))<2,'Keep the bottom edge attached to the actual plus anchor');
      await page.setViewportSize({width,height:852});await page.waitForTimeout(350);
      assert.equal(await input.textContent(),'单击就能输入 mixed draft');
    }
    assert.deepEqual(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>/^turn\.(start|interrupt)$/.test(t))),[]);
    reports.push({width,theme,oneTapFocus:mobile?true:'unchanged-desktop',menu:check,productionWrites:0});
    console.log(JSON.stringify(reports.at(-1)));await context.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({cases:reports.length,errors,productionWrites:0}));
} finally {await browser.close();}
