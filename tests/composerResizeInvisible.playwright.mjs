import { chromium } from '@playwright/test';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { installMobileChromeFixture } from './mobileChromeFixture.mjs';

const base = 'http://127.0.0.1:4574', user = process.env.QA_USER_ID;
const secret = (await fs.readFile(process.env.QA_SESSION_SECRET_FILE, 'utf8')).trim();
const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 600000 })).toString('base64url');
const browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH });
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await context.addCookies([{ name: 'codex_remote_session_4575', value: payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url'), url: base }]);
    await installMobileChromeFixture(context, user);
    await context.addInitScript(t => localStorage.setItem('codex-web-color-theme', t), theme);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/?project=mobile-project&thread=mobile-thread');
    const handle = page.locator('.composerResizeHandle'), input = page.locator('.composerRichInput');
    await input.waitFor(); await handle.waitFor(); await page.waitForTimeout(400);
    const rect = await handle.boundingBox();
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const visual = await handle.evaluate(e => ({ content: getComputedStyle(e, '::after').content, cursor: getComputedStyle(e).cursor }));
    assert.equal(visual.content, 'none'); assert.equal(visual.cursor, 'ns-resize');
    const before = await page.locator('.conversation>.composer').boundingBox();
    await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2, rect.y - 70, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await page.locator('.conversation>.composer').boundingBox();
    const stored = await page.evaluate(() => localStorage.getItem('codex-web-composer-height'));
    assert.ok(after.height > before.height + 30, JSON.stringify({ before, after, stored }));
    assert.ok(Number(stored) > 54);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.mobileQaSocket.requests.filter(x => /^turn\.(start|interrupt)$/.test(x))), []);
    console.log(JSON.stringify({ theme, hoverLine: visual.content, cursor: visual.cursor, before: before.height, after: after.height, errors }));
    await context.close();
  }
} finally { await browser.close(); }
