// Isolated CSS regression: no server, credentials, model requests or sockets.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const css = (await Promise.all([
  'styles.css', 'softCorners.css', 'mobileSidebar.css',
  'panelTypography.css', 'mobileReading.css', 'readingScale.css', 'BrowserPanel.css',
].map(file => fs.readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')))).join('\n');
const browser = await chromium.launch({
  ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}),
});
const reports = [];
try {
  for (const width of [360, 393, 1280]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 852 }, isMobile: width <= 720, hasTouch: width <= 720 });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>
      <section class="threadColumn"><div class="topbar"><div class="controls">
        <button class="trackedQuotaButton"><span>用量</span></button>
      </div></div><div class="messages">
        <div class="v2ThinkingLine">正在思考</div>
        <div class="messageItem kind-tool toolBundle"><div class="messageMeta toolBundleTitle"><span class="toolBundleTitleLabel">调用工具</span></div></div>
        <div class="messageItem kind-agent"><div class="messageMarkdown"><p>正文</p></div></div>
      </div></section>
      <div class="composerRichInput" contenteditable="true"><p class="is-empty" data-placeholder="随心输入"></p></div>
      <div class="workspace"><aside class="threadList"><div class="v2ProjectDock"><nav class="v2PrimaryNav"><button><strong>新建对话</strong></button></nav></div><div class="listHeader">项目</div><button class="v2WorkspaceFolderButton"><strong>我的工作区</strong></button><div class="v2AccountDock">账号</div></aside></div>
      <section class="rightWorkspace"><div class="mobileRightResourceDock"><div class="hostResourceDock"><button><span>CPU</span></button></div></div></section>
      <aside class="browserPanel"><div class="browserTabBar" data-empty="true"><div class="browserTabs"></div><button class="browserNewTab">+</button></div><form class="browserAddress"><input aria-label="网址"><button class="browserNewTab browserNewTabInline">+</button></form></aside>
    </body></html>`);
    const report = await page.evaluate(() => {
      const style = selector => { const s = getComputedStyle(document.querySelector(selector)); return { size: s.fontSize, weight: s.fontWeight, family: s.fontFamily, animation: s.animationName }; };
      return { body: style('.messageMarkdown p'), tool: style('.toolBundleTitleLabel'), thinking: style('.v2ThinkingLine'), header: style('.trackedQuotaButton span'), resource: style('.hostResourceDock button'), input: style('.composerRichInput'), sidebar: style('.v2PrimaryNav strong'), workspace: style('.v2WorkspaceFolderButton strong'), placeholder: getComputedStyle(document.querySelector('.is-empty'), '::before').fontSize, panel: getComputedStyle(document.documentElement).getPropertyValue('--panel-text-size').trim(), emptyTabRow: getComputedStyle(document.querySelector('.browserTabBar')).display, inlineNewTab: getComputedStyle(document.querySelector('.browserNewTabInline')).display, sidebarSurfaces: [...document.querySelectorAll('.workspace>.threadList,.threadList>.v2ProjectDock,.threadList>.listHeader,.threadList>.v2AccountDock')].map(element=>getComputedStyle(element).backgroundColor) };
    });
    if (width <= 720) {
      for (const name of ['body', 'tool', 'thinking']) {
        assert.equal(report[name].size, '15px', `${width}/${theme} ${name} size`);
        assert.equal(report[name].weight, '400', `${width}/${theme} ${name} weight`);
      }
      assert.equal(report.thinking.family, report.tool.family);
      assert.equal(report.placeholder, '15px');
      assert.equal(report.input.size, '16px', 'Keep iOS focus-zoom protection');
      assert.equal(report.emptyTabRow, 'none');
      assert.notEqual(report.inlineNewTab, 'none');
      for (const name of ['sidebar', 'workspace']) {
        assert.equal(report[name].size, '16px');
        assert.equal(report[name].weight, '400');
      }
      assert.equal(new Set(report.sidebarSurfaces).size, 1, 'Mobile sidebar must have one continuous surface');
      for (const name of ['header', 'resource']) assert.equal(report[name].size, '13px', `${name} must leave room inside small mobile controls`);
    } else {
      assert.equal(report.body.size, '14px');
      assert.equal(report.thinking.weight, '650', 'Desktop thinking styling stays unchanged');
      assert.equal(report.panel, '13px');
      assert.equal(report.emptyTabRow, 'flex', 'Desktop tab bar must stay unchanged');
      assert.equal(report.inlineNewTab, 'none');
    }
    assert.match(report.thinking.animation, /shimmer/, 'Typography must not disable shimmer');
    reports.push({ width, theme, ...report });
    await page.close();
  }
  console.log(JSON.stringify({ cases: reports.length, reports, productionRequests: 0 }));
} finally {
  await browser.close();
}
