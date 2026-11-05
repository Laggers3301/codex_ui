import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
const css=(await Promise.all(['styles.css','taskNotificationSettings.css','globalDialogs.css'].map(f=>fs.readFile(new URL('../src/'+f,import.meta.url),'utf8')))).join('\n');
const browser=await chromium.launch({headless:true});
const results=[];
try{
  const page=await browser.newPage();
  for(const mobile of [false,true])for(const theme of ['light','dark']){
    await page.setViewportSize(mobile?{width:393,height:852}:{width:1280,height:900});
    await page.setContent(`<html data-theme="${theme}"><head><style>:root{--pool-ui-font:Arial,sans-serif;--line:#8884;--ui-content:#ccc;--ui-heading:#eee;}${css}</style></head><body></body></html>`);
    for(const [scrim,panel] of [['taskNotificationScrim','taskNotificationDialog'],['workspaceFeatureScrim','workspaceFeatureDialog'],['modalScrim','renameThreadDialog'],['modalBackdrop','settingsDialog'],['modalScrim','directoryDialog'],['globalSearchScrim','globalSearchDialog'],['feishuScrim','feishuDialog'],['petPickerScrim','petPicker'],['skillPickerScrim','skillPickerPopover']]){
      await page.evaluate(({scrim,panel})=>{document.body.innerHTML=`<div class="${scrim}"><section class="${panel}"><h2>标题</h2><label>字段<button>操作</button></label></section></div>`;},{scrim,panel});
      const style=await page.evaluate(()=>{const veil=getComputedStyle(document.body.firstElementChild),panel=getComputedStyle(document.querySelector('section')),heading=getComputedStyle(document.querySelector('h2'));return{blur:veil.backdropFilter,bg:panel.backgroundColor,font:panel.fontSize,weight:panel.fontWeight,radius:panel.borderRadius,heading:heading.fontSize,entrance:panel.animationName};});
      assert.equal(style.blur,'blur(5px)');assert.equal(style.font,'14px');assert.equal(style.weight,'400');assert.equal(style.radius,'18px');assert.equal(style.heading,'14px');assert.equal(style.entrance,'globalDialogPanelIn');
      await page.evaluate(()=>document.body.firstElementChild.classList.add('uiClosing'));
      assert.equal(await page.locator('section').evaluate(n=>getComputedStyle(n).animationName),'globalDialogPanelOut');
      results.push({mobile,theme,panel,...style});
    }
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('section').evaluate(n=>getComputedStyle(n).animationName),'none');
  console.log(JSON.stringify({checks:results.length,reducedMotion:true,allPassed:true}));
}finally{await browser.close();}
