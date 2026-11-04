import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';

test('activity sizes remain independent of prose on desktop and mobile',async()=>{
  const css=(await Promise.all(['styles.css','mobileReading.css','readingScale.css','toolTypography.css']
    .map(name=>readFile(new URL('../src/'+name,import.meta.url),'utf8')))).join('\n');
  const browser=await chromium.launch({headless:true});
  try{
    for(const width of [1280,393])for(const theme of ['light','dark']){
      const page=await browser.newPage({viewport:{width,height:852}});
      await page.setContent(`<html data-theme="${theme}"><body>
        <article class="messageItem kind-agent"><div class="messageMarkdown"><p>正文</p></div></article>
        <article class="messageItem kind-tool toolBundle"><div class="messageMeta">
          <span class="toolBundleTitleLabel">调用工具</span><span class="toolBundleEntryLabel">读取文件</span>
          <span class="toolBundleEntrySummary">查看实现</span><span class="toolRollingCount">3</span>
        </div><pre class="toolBundleInput">input</pre></article>
        <article class="messageItem kind-reasoning"><span class="reasoningLabel">思考</span>
          <span class="reasoningSummaryPreview">摘要</span><div class="reasoningExpandedBody"><div class="messageMarkdown"><p>详情</p></div></div></article>
        <div class="v2ThinkingLine">正在思考</div><time class="messageSentTime">2026/01/01 12:00</time>
        </body></html>`);
      await page.addStyleTag({content:css});
      const sizes=await page.evaluate(()=>Object.fromEntries([
        '.toolBundleTitleLabel','.toolBundleEntryLabel','.toolBundleEntrySummary','.toolRollingCount','.toolBundleInput',
        '.reasoningLabel','.reasoningSummaryPreview','.reasoningExpandedBody p','.v2ThinkingLine','.messageSentTime',
        '.kind-agent .messageMarkdown p'
      ].map(selector=>[selector,getComputedStyle(document.querySelector(selector)).fontSize])));
      for(const [selector,size]of Object.entries(sizes)){
        const expected=selector==='.v2ThinkingLine'?'14px':selector==='.messageSentTime'?'13px':selector.startsWith('.kind-agent')?(width<720?'15px':'14px'):'12px';
        assert.equal(size,expected,`${width}/${theme} ${selector}`);
      }
      await page.close();
    }
  }finally{await browser.close();}
});
