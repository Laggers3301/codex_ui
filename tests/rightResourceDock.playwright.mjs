import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { installMobileChromeFixture } from './mobileChromeFixture.mjs';

const base = 'http://127.0.0.1:4574', user = process.env.QA_USER_ID;
const secret = (await fs.readFile(process.env.QA_SESSION_SECRET_FILE, 'utf8')).trim();
const payload = Buffer.from(JSON.stringify({ u:user, exp:Date.now()+600000 })).toString('base64url');
const browser = await chromium.launch({ executablePath:process.env.QA_CHROMIUM_PATH });
const reports=[], errors=[];
try {
  for (const width of [320,393,1280]) for (const theme of ['light','dark']) {
    const mobile=width<=720, context=await browser.newContext({viewport:{width,height:852},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
    await context.addCookies([{name:'codex_remote_session_4575',value:payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url'),url:base}]);
    await installMobileChromeFixture(context,user);
    if (!mobile) await context.addInitScript(()=>localStorage.setItem('codex-web-diff-panel-width','350'));
    await context.addInitScript(t=>localStorage.setItem('codex-web-color-theme',t),theme);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/?project=mobile-project&thread=mobile-thread');await page.locator('.composerRichInput').waitFor();
    if(mobile) await page.locator('.threadList').evaluate(e=>{if(!e.classList.contains('collapsed'))e.querySelector('.v2SidebarToggle')?.click()});
    await page.locator('.topbar button[aria-label="显示右栏"]:visible').click();
    const card=page.locator('.rightWorkspaceOverviewCard'), dock=card.locator('.hostResourceDock');
    await dock.waitFor();await page.waitForTimeout(400);
    assert.equal(await page.locator('.threadList .hostResourceDock').count(),0);
    assert.equal(await dock.locator('button').count(),4);
    const sizes=await dock.evaluate(e=>({dock:e.getBoundingClientRect().toJSON(),buttons:[...e.querySelectorAll('button')].map(b=>({rect:b.getBoundingClientRect().toJSON(),width:b.clientWidth,scroll:b.scrollWidth,font:getComputedStyle(b).fontSize})),card:e.closest('.rightWorkspaceOverviewCard').getBoundingClientRect().toJSON(),radius:getComputedStyle(e.closest('.rightWorkspaceOverviewCard')).borderRadius,background:getComputedStyle(e.closest('.rightWorkspaceOverviewCard')).backgroundColor,order:[...e.closest('.rightWorkspaceOverviewCard').children].map(x=>x.className)}));
    assert.ok(sizes.order[0].includes('rightWorkspaceResources'));assert.ok(sizes.buttons.every(b=>b.rect.width>0&&b.scroll<=b.width+1),JSON.stringify(sizes));
    assert.ok(sizes.dock.x>=sizes.card.x&&sizes.dock.right<=sizes.card.right+1);
    assert.ok(sizes.buttons.every(b=>Math.abs(b.rect.y-sizes.buttons[0].rect.y)<1));
    assert.notEqual(sizes.background,'rgba(0, 0, 0, 0)');assert.ok(parseFloat(sizes.radius)>10);
    const schedule=card.getByText('定时任务',{exact:true});await schedule.waitFor();assert.ok((await schedule.boundingBox()).y>sizes.dock.bottom);
    await page.screenshot({path:`/tmp/right-resource-${width}-${theme}.png`});
    await dock.getByRole('button',{name:'查看主机资源',exact:true}).click();
    await page.getByRole('region',{name:'主机资源',exact:true}).waitFor();
    if(mobile) assert.ok((await page.locator('.threadList').getAttribute('class')).includes('collapsed'));
    await page.locator('#right-tab-overview').click();await dock.waitFor();
    await dock.getByRole('button',{name:'检测 Google HTTPS'}).click();
    await page.getByRole('region',{name:'主机资源',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.mobileQaSocket.requests.filter(x=>/^turn\.(start|interrupt)$/.test(x))),[]);
    reports.push({width,theme,dockWidth:sizes.dock.width,buttonWidths:sizes.buttons.map(b=>b.rect.width),buttonFonts:sizes.buttons.map(b=>b.font),radius:sizes.radius});
    console.log(JSON.stringify(reports.at(-1)));await context.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({cases:reports.length,errors,productionConversationWrites:0}));
} finally {await browser.close();}
