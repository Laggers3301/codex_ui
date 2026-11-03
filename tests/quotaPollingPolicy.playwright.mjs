import { chromium } from '@playwright/test';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { installMobileChromeFixture } from './mobileChromeFixture.mjs';

const base = 'http://127.0.0.1:4574', user = process.env.QA_USER_ID;
const secret = (await fs.readFile(process.env.QA_SESSION_SECRET_FILE, 'utf8')).trim();
const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 600000 })).toString('base64url');
const browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
try {
  await context.addCookies([{ name: 'codex_remote_session_4575', value: payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url'), url: base }]);
  await installMobileChromeFixture(context, user);
  // Accelerate only the application's retry and healthy polling intervals.
  await context.addInitScript(() => { const old = window.setTimeout; window.setTimeout = (fn, ms, ...args) => old(fn, ms === 15000 ? 400 : ms === 180000 ? 5000 : ms, ...args); });
  const requests = [], errors = [];
  await context.route('**/api/codex/account-pool**', async route => {
    requests.push(new URL(route.request().url()).searchParams.get('refresh') === 'true');
    const accounts = Array.from({ length: 7 }, (_, i) => ({ id: 'fixture-' + i, label: 'Fixture ' + i, kind: i < 4 ? 'codex-account' : 'api-provider', health: 'ready', assignedThreadCount: 0, activeRequests: 0, lastCheckedAt: null,
      quota: { account: { type: 'chatgpt' }, rateLimits: i < 4 ? { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null } } : null, rateLimitsByLimitId: {}, errors: [], updatedAt: new Date().toISOString() }
    }));
    await new Promise(resolve => setTimeout(resolve, 120));
    return route.fulfill({ json: { data: { accounts, strategy: 'highest-remaining-sticky-thread', updatedAt: new Date().toISOString() } } });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/?project=mobile-project&thread=mobile-thread'); await page.locator('.composerRichInput').waitFor();
  await page.waitForTimeout(1800);
  const automatic = [...requests];
  assert.ok(automatic.length >= 1 && automatic.length <= 4, JSON.stringify(automatic));
  assert.ok(automatic.every(force => !force), JSON.stringify(automatic));
  await page.locator('.quotaButton').click(); await page.waitForTimeout(600);
  assert.ok(requests.includes(true), 'explicit click must still force refresh');
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.mobileQaSocket.requests.filter(x => /^turn\.(start|interrupt)$/.test(x))), []);
  console.log(JSON.stringify({ automaticRequests: automatic.length, automaticForceRequests: automatic.filter(Boolean).length, manualRefreshWorks: requests.includes(true), errors }));
} finally { await context.close(); await browser.close(); }
