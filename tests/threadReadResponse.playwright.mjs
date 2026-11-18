import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { installMobileChromeFixture } from './mobileChromeFixture.mjs';

// Only load static assets from 5520. All APIs and WebSockets use private fixtures.
const origin = process.env.QA_ORIGIN ?? 'http://127.0.0.1:5520';
const evidence = './output/qa/thread-read-response-20261117';
await fs.mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [], results = [];
try {
  for (const mobile of [false, true]) for (const malformed of ['missing-thread', 'invalid-json']) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 393, height: 852 } : { width: 1440, height: 1000 },
      serviceWorkers: 'block'
    });
    try {
      await installMobileChromeFixture(context, 'qa');
      let invalid = true, rejectedReads = 0;
      await context.route('**/api/threads/mobile-thread?*', async route => {
        if (!invalid) return route.fallback();
        rejectedReads++;
        return malformed === 'missing-thread'
          ? route.fulfill({ json: { history: { totalItems: 1, returnedItems: 1, before: 0, nextBefore: 1, hasOlder: false } } })
          : route.fulfill({ contentType: 'text/html', body: '<html><body>Upstream unavailable</body></html>' });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/?project=mobile-project&thread=mobile-thread');
      const notice = page.locator('.errorBannerMessage').first();
      await expect(notice).toHaveText(process.env.QA_EXPECT_OLD_ERROR === '1'
        ? /Cannot read properties of undefined.*id/
        : malformed === 'missing-thread' ? /会话内容响应不完整/ : /服务器响应无法解析/);
      assert.ok(rejectedReads > 0);
      assert.equal(await page.locator('#conversation-messages').getByText('检查手机左栏、正文和右栏。', { exact: true }).count(), 0);
      const message = await notice.innerText();
      await page.screenshot({ path: `${evidence}/${mobile ? 'phone' : 'desktop'}-${malformed}.png` });

      invalid = false;
      if (mobile) await page.getByRole('button', { name: '展开侧边栏', exact: true }).first().click();
      await page.locator('[data-thread-id="mobile-thread"] .threadSelectButton').click();
      await expect(page.locator('#conversation-messages').getByText('检查手机左栏、正文和右栏。', { exact: true })).toBeVisible();
      await expect(page.locator('.errorBannerMessage')).toHaveCount(0);
      const writes = await page.evaluate(() => window.mobileQaSocket.requests.filter(type => /^turn\.(start|interrupt)$/.test(type)));
      assert.deepEqual(writes, []);
      results.push({ mobile, malformed, message, recoveredWithoutReload: true, modelWrites: writes.length });
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  const report = { origin, results, errors };
  await fs.writeFile(`${evidence}/results${process.env.QA_EXPECT_OLD_ERROR === '1' ? '-before' : ''}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
