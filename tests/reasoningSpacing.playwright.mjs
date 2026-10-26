import {chromium} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
// Load only built CSS into an isolated DOM: no production API or model call.
const root=path.resolve('dist');const html=await fs.readFile(path.join(root,'index.html'),'utf8');
const sheets=[...html.matchAll(/href="([^\"]+\.css)"/g)].map(m=>path.join(root,m[1].replace(/^\//,'')));
const css=(await Promise.all(sheets.map(p=>fs.readFile(p,'utf8')))).join('\n');
const browser=await chromium.launch({headless:true});const results=[];
const evidence='./output/qa/reasoning-spacing-20261026';await fs.mkdir(evidence,{recursive:true,mode:0o700});
try {
 for(const width of [1280,393])for(const theme of ['light','dark']){
  const page=await browser.newPage({viewport:{width,height:700}});await page.route('**/*',route=>route.abort());
  await page.setContent(`<html data-theme="${theme}"><body><main style="width:min(860px,calc(100vw - 32px));margin:24px auto">
  <section class="conversationTurnRow"><article class="messageItem kind-agent beforeReason"><div class="messageMarkdown"><p>这一段正文后接独立思考，应该与工具行保持同样的紧凑间距。</p></div></article><article class="messageItem kind-reasoning"><div class="reasoningDisclosure"><button class="reasoningDisclosureTrigger"><span>◉</span><span>思考</span><span class="reasoningSummaryPreview">正在核对具体原因与实现</span></button></div></article></section>
  <section class="conversationTurnRow"><article class="messageItem kind-agent beforeTool"><div class="messageMarkdown"><p>这一段正文后接工具行，作为原有间距的对照。</p></div></article><article class="messageItem kind-tool toolBundle"><div class="messageMeta toolBundleTitle"><span class="toolBundleTitleLabel">调用工具 · exec × 1</span></div></article></section></main></body></html>`);
  await page.addStyleTag({content:css});
  const geometry=await page.evaluate(()=>{
   const gap=(a,b)=>document.querySelector(b).getBoundingClientRect().top-document.querySelector(a).getBoundingClientRect().bottom;
   return{reasoningGap:gap('.beforeReason','.kind-reasoning'),toolGap:gap('.beforeTool','.toolBundle'),reasoningMargin:getComputedStyle(document.querySelector('.beforeReason')).marginBottom,toolMargin:getComputedStyle(document.querySelector('.beforeTool')).marginBottom};
  });assert.equal(geometry.reasoningMargin,'4px');assert.equal(geometry.toolMargin,'4px');assert.ok(Math.abs(geometry.reasoningGap-geometry.toolGap)<=2,JSON.stringify(geometry));
  await page.screenshot({path:`${evidence}/${width}-${theme}.png`});results.push({width,theme,...geometry});await page.close();
 }
 await fs.writeFile(`${evidence}/results.json`,JSON.stringify({at:new Date().toISOString(),results,conversationWrites:0},null,2),{mode:0o600});console.log(JSON.stringify(results));
}finally{await browser.close()}
