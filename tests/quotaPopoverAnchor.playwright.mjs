import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { installMobileChromeFixture } from './mobileChromeFixture.mjs';

// Only static assets come from the console. All APIs and sockets are fixtures.
const base = process.env.QA_BASE_URL ?? 'http://127.0.0.1:4574';
const user = process.env.QA_USER_ID;
if (!user || !process.env.QA_SESSION_SECRET_FILE) throw Error('Explicit QA user and session secret path required');
const evidence = process.env.QA_EVIDENCE_DIR ?? '/tmp/quota-popover-anchor';
await fs.mkdir(evidence, { recursive: true, mode: 0o700 });
const browser = await chromium.launch(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {});
const reports = [], errors = [], writes = [];
try {
  for (const width of (process.env.QA_QUICK === '1' ? [393] : [360, 393, 1280])) for (const theme of ['light', 'dark']) {
    const mobile = width <= 720;
    const context = await browser.newContext({ viewport: { width, height: 852 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
    const secret = (await fs.readFile(process.env.QA_SESSION_SECRET_FILE, 'utf8')).trim();
    const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 600000 })).toString('base64url');
    await context.addCookies([{ name: 'codex_remote_session_4575', value: payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url'), url: base }]);
    await installMobileChromeFixture(context, user);
    await context.addInitScript(theme => localStorage.setItem('codex-web-color-theme', theme), theme);
    await context.route('**/api/codex/account-pool**', route => route.fulfill({ json: { data: {
      currentThreadAccountId: 'fixture-0', updatedAt: new Date().toISOString(),
      accounts: Array.from({ length: 4 }, (_, i) => ({ id: `fixture-${i}`, label: `Account ${i + 1}`, health: 'ready', kind: 'codex-account', assignedThreadCount: 1,
        quota: { account: { type: 'chatgpt' }, rateLimits: { primary: { usedPercent: i === 0 ? 91 : 40, windowDurationMins: 300, resetsAt: null } }, errors: [], updatedAt: new Date().toISOString() }
      }))
    } } }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    // Fixture prediction generation is expected; the shared fixture intercepts
    // it too. Record conversation mutations, not read-like prediction POSTs.
    page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/') && !path.endsWith('/prediction') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method() + ' ' + path); });
    await page.goto(base + '/?project=mobile-project&thread=mobile-thread');
    await page.locator('.composerRichInput').waitFor();
    if (mobile) {
      await page.locator('.threadList').evaluate(e => { if (!e.classList.contains('collapsed')) e.querySelector('.v2SidebarToggle')?.click(); });
      await page.locator('.mobileHeaderTitle').click();
    }
    await page.locator('.exhaustedAccountNotice').waitFor();
    await page.waitForTimeout(450);
    const trigger = page.locator('.quotaButton');
    const measure = async () => {
      const panel = await page.locator('.quotaPopover').boundingBox(), button = await trigger.boundingBox();
      return { gap: panel.y - button.y - button.height, panel, button };
    };
    await trigger.click();
    await page.waitForTimeout(350);
    const beforeDismiss = await measure();
    await trigger.click();
    await page.locator('.exhaustedAccountNotice').getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.exhaustedAccountNotice').waitFor({ state: 'detached' });
    await trigger.click();
    await page.waitForTimeout(350);
    const afterDismiss = await measure();
    const geometry = await page.locator('.topbar>.controls').evaluate(e => ({ rect: e.getBoundingClientRect().toJSON(), willChange: getComputedStyle(e).willChange, transform: getComputedStyle(e).transform }));
    await page.screenshot({ path: `${evidence}/${width}-${theme}.png` });
    const report = { width, theme, beforeDismiss, afterDismiss, geometry };
    reports.push(report); console.log(JSON.stringify(report));
    if (process.env.QA_BASELINE !== '1') {
      for (const measurement of [beforeDismiss, afterDismiss]) {
        assert.ok(Math.abs(measurement.gap - 8) < 2, 'Popover must sit 8px below its button: ' + JSON.stringify(report));
        assert.ok(measurement.panel.x >= 0 && measurement.panel.x + measurement.panel.width <= width + 1);
      }
      // Tabs must remain hittable after the notice has been dismissed.
      await page.locator('[data-account-id="fixture-1"]').click();
      await page.locator('[data-account-id="fixture-1"].active').waitFor();
      if (mobile) {
        await page.setViewportSize({ width, height: 652 }); await page.waitForTimeout(350);
        assert.ok(Math.abs((await measure()).gap - 8) < 2);
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  await fs.writeFile(`${evidence}/results.json`, JSON.stringify({ at: new Date().toISOString(), reports, errors, productionWrites: writes.length }, null, 2), { mode: 0o600 });
} finally { await browser.close(); }
