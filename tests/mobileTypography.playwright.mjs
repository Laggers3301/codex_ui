// Isolated CSS regression: no server, credentials, model requests or sockets.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const css = (await Promise.all([
  'styles.css', 'toolActivityMotion.css', 'softCorners.css', 'mobileSidebar.css',
  'panelTypography.css', 'mobileReading.css', 'readingScale.css', 'BrowserPanel.css', 'composerLiquidGlass.css',
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
      <section class="threadColumn"><div class="topbar"><div class="controls trackedQuotaVisible">
        <button class="trackedQuotaButton"><span>用量</span></button>
        <div class="topbarPolicySelect"><button class="polishedSelectTrigger"><span>完全访问</span><span class="polishedSelectChevron"></span></button></div>
      </div></div><div class="messages">
        <div class="v2ThinkingLine">正在思考</div>
        <article class="messageItem kind-user"><div>引导消息</div><div class="v2UserMessageActions"><button aria-label="复制消息">□</button></div></article>
        <div class="messageItem kind-tool toolBundle toolBundleShimmering"><div class="messageMeta toolBundleTitle"><span class="toolBundleTitleLabel">调用工具 <span class="toolRollingCount"><span class="toolCountGlyph">2</span></span></span></div><div class="toolBundleEntries"><article class="messageItem kind-tool toolBundleEntry"><div class="messageMeta"><span class="toolBundleEntryLabel">调用工具 · exec</span><span class="toolBundleEntrySummary">fixture</span></div></article></div></div>
        <div class="messageItem kind-agent"><div class="messageMarkdown"><p>正文</p></div></div>
      </div></section>
      <div class="composerRichInput" contenteditable="true"><p class="is-empty" data-placeholder="随心输入"></p></div>
      <div class="queuedSubmissionStrip">已排队</div>
      <div class="workspace"><aside class="threadList"><div class="v2ProjectDock"><div class="v2BrandRow"><strong>Codex</strong></div><nav class="v2PrimaryNav"><button><strong>新建对话</strong></button></nav></div><div class="listHeader">项目</div><button class="v2WorkspaceFolderButton"><strong>我的工作区</strong></button><div class="v2AccountDock">账号</div></aside></div>
      <section class="rightWorkspace"><div class="mobileRightResourceDock"><div class="hostResourceDock"><button><span>CPU</span></button></div></div></section>
      <aside class="browserPanel"><div class="browserTabBar" data-empty="true"><div class="browserTabs"></div><button class="browserNewTab">+</button></div><form class="browserAddress"><input aria-label="网址"><button class="browserNewTab browserNewTabInline">+</button></form></aside>
    </body></html>`);
    const report = await page.evaluate(() => {
      const style = selector => { const s = getComputedStyle(document.querySelector(selector)); return { size: s.fontSize, weight: s.fontWeight, family: s.fontFamily, animation: s.animationName }; };
      const toolEntries = [...document.querySelectorAll('.toolBundleEntryLabel,.toolBundleEntrySummary')].map(element=>{const s=getComputedStyle(element);return{size:s.fontSize,weight:s.fontWeight,family:s.fontFamily,tracking:s.letterSpacing};});
      const toolPaint = {parent: getComputedStyle(document.querySelector('.toolBundle>.messageMeta')).backgroundImage, label: getComputedStyle(document.querySelector('.toolBundleTitleLabel')).backgroundImage, entryParent: getComputedStyle(document.querySelector('.toolBundleEntry>.messageMeta')).backgroundImage};
      const queue = getComputedStyle(document.querySelector('.queuedSubmissionStrip'));
      const policyLine=getComputedStyle(document.querySelector('.topbarPolicySelect .polishedSelectTrigger>span:first-child')).lineHeight;
      const copyClearance=document.querySelector('.toolBundle').getBoundingClientRect().top-document.querySelector('.v2UserMessageActions').getBoundingClientRect().bottom;
      return { body: style('.messageMarkdown p'), tool: style('.toolBundleTitleLabel'), toolEntries, toolPaint, thinking: style('.v2ThinkingLine'), header: style('.trackedQuotaButton span'), policyLine, resource: style('.hostResourceDock button'), input: style('.composerRichInput'), sidebar: style('.v2PrimaryNav strong'), workspace: style('.v2WorkspaceFolderButton strong'), brand: style('.v2BrandRow>strong'), copyClearance, queueBlur: queue.backdropFilter, queuePrefixedBlur: queue.webkitBackdropFilter, invalidNoneFallback: CSS.supports('backdrop-filter', 'none blur(12px)'), placeholder: getComputedStyle(document.querySelector('.is-empty'), '::before').fontSize, panel: getComputedStyle(document.documentElement).getPropertyValue('--panel-text-size').trim(), emptyTabRow: getComputedStyle(document.querySelector('.browserTabBar')).display, inlineNewTab: getComputedStyle(document.querySelector('.browserNewTabInline')).display, sidebarSurfaces: [...document.querySelectorAll('.workspace>.threadList,.threadList>.v2ProjectDock,.threadList>.listHeader,.threadList>.v2AccountDock')].map(element=>getComputedStyle(element).backgroundColor) };
    });
    if (width <= 720) {
      for (const name of ['body', 'tool']) {
        assert.equal(report[name].size, '15px', `${width}/${theme} ${name} size`);
        assert.equal(report[name].weight, '400', `${width}/${theme} ${name} weight`);
      }
      assert.equal(report.thinking.family, report.tool.family);
      assert.equal(report.thinking.size, '15px');
      assert.equal(report.thinking.weight, '450');
      assert.equal(report.policyLine, '20px', 'Old 18px rules must not lift policy labels above quota labels');
      assert.equal(report.placeholder, '16px');
      assert.equal(report.input.size, '16px', 'Keep iOS focus-zoom protection');
      assert.equal(report.emptyTabRow, 'none');
      assert.notEqual(report.inlineNewTab, 'none');
      for (const name of ['sidebar', 'workspace']) {
        assert.equal(report[name].size, '15px');
        assert.equal(report[name].weight, '450');
      }
      assert.equal(report.brand.size, '17px');
      for (const entry of report.toolEntries) {
        assert.equal(entry.size, report.body.size);
        assert.equal(entry.weight, report.body.weight);
        assert.equal(entry.family, report.body.family);
        assert.equal(entry.tracking, 'normal');
      }
      assert.equal(report.toolPaint.parent, 'none');
      assert.equal(report.toolPaint.entryParent, 'none');
      assert.match(report.toolPaint.label, /gradient/);
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
    assert.equal(report.brand.weight, '700', 'Keep original Codex brand weight on both platforms');
    assert.ok(report.copyClearance>=12, `Copy actions must not crowd tools (${width}/${theme}: ${report.copyClearance})`);
    assert.equal(report.invalidNoneFallback, false, 'The old Safari fallback was syntactically invalid');
    assert.match(report.queueBlur, /blur\(12px\)/, 'No SVG variable must still produce a valid blur');
    // Chromium no longer exposes the prefixed property; the native WebKit
    // declaration is checked only on engines that support that alias.
    if (await page.evaluate(() => CSS.supports('-webkit-backdrop-filter', 'blur(12px)'))) assert.match(report.queuePrefixedBlur, /blur\(12px\)/);
    reports.push({ width, theme, ...report });
    await page.close();
  }
  console.log(JSON.stringify({ cases: reports.length, reports, productionRequests: 0 }));
} finally {
  await browser.close();
}
