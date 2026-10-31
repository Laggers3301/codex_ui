// Static assets only. API writes/deletes and all WebSockets are browser fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {chromium} from '@playwright/test';
import {installMobileChromeFixture} from './mobileChromeFixture.mjs';
const base=process.env.QA_BASE_URL??'http://127.0.0.1:4574',user=process.env.QA_USER_ID;
if(!user)throw Error('Explicit QA_USER_ID required');
const browser=await chromium.launch(process.env.QA_CHROMIUM_PATH?{executablePath:process.env.QA_CHROMIUM_PATH}:{});
const reports=[],errors=[];
try{
 if(process.env.QA_SCREENSHOT_DIR)await fs.mkdir(process.env.QA_SCREENSHOT_DIR,{recursive:true,mode:0o700});
 const cases=process.env.QA_QUICK?[{width:393,theme:'light'}]:[393,360,1280].flatMap(width=>['light','dark'].map(theme=>({width,theme})));
 for(const {width,theme} of cases){
  const mobile=width<=720,context=await browser.newContext({viewport:{width,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
  if(process.env.QA_SESSION_SECRET_FILE){const secret=(await fs.readFile(process.env.QA_SESSION_SECRET_FILE,'utf8')).trim(),p=Buffer.from(JSON.stringify({u:user,exp:Date.now()+600000})).toString('base64url');await context.addCookies([{name:'codex_remote_session_4575',value:p+'.'+createHmac('sha256',secret).update(p).digest('base64url'),url:base}]);}
  await installMobileChromeFixture(context,user);
  let projects=[{id:'mobile-project',name:'我的工作区',rootPath:'/fixture',userId:user,defaultModel:'gpt-6.1-sol',defaultSandbox:'danger-full-access',defaultApprovalPolicy:'never'},{id:'local-project',name:'本地管理测试',rootPath:'/fixture/local',userId:user}];
  let threads=[{id:'mobile-thread',name:'手机阅读与侧栏',cwd:'/fixture',createdAt:1,updatedAt:1,status:'idle'},{id:'local-thread',name:'本地管理会话',cwd:'/fixture',createdAt:1,updatedAt:1,status:'idle'}];
  let deletes=0;
  await context.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()==='DELETE'){deletes++;if(url.pathname.endsWith('/local-thread'))threads=threads.filter(t=>t.id!=='local-thread');else if(url.pathname==='/api/projects/local-project')projects=projects.filter(p=>p.id!=='local-project');else throw Error('Unexpected fixture delete target');return route.fulfill({json:{ok:true}});}
   if(request.method()==='GET'&&url.pathname==='/api/projects')return route.fulfill({json:{data:projects,projectRoot:'/fixture'}});
   if(request.method()==='GET'&&url.pathname==='/api/projects/mobile-project/threads')return route.fulfill({json:{data:threads}});
   return route.fallback();
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/?project=mobile-project&thread=mobile-thread`);await page.getByText('检查手机左栏、正文和右栏。',{exact:true}).waitFor();
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await page.waitForTimeout(450);
  const sidebar=page.locator('.threadList');
  const sidebarOpen=async()=>{if(await sidebar.evaluate(e=>e.classList.contains('collapsed')))await page.locator('.mobileSidebarToggle').click();await page.waitForTimeout(400);assert.equal(await sidebar.evaluate(e=>e.classList.contains('collapsed')),false);};
  const stays=async()=>{await page.waitForTimeout(400);assert.equal(await sidebar.evaluate(e=>e.classList.contains('collapsed')),false,'Local sidebar management must not close the drawer');};
  await sidebarOpen();
  await sidebar.locator('[title="Refresh threads"]').click();await stays();
  const group=sidebar.locator('.v2WorkspaceGroup[data-project-id="local-project"]');
  await group.locator('.projectRenameButton').click();const rename=page.locator('.renameThreadDialog');await rename.waitFor();await stays();await rename.getByRole('button',{name:'取消',exact:true}).click();await stays();
  const row=sidebar.locator('.threadRow[data-thread-id="local-thread"]');
  await row.locator('.threadRenameButton:not(.threadPinButton)').click();await rename.waitFor();await stays();await rename.getByRole('button',{name:'取消',exact:true}).click();await stays();
  await row.locator('.threadDeleteButton').click();await stays();assert.equal(deletes,0,'First delete click is confirmation only');assert.ok((await row.locator('.threadDeleteButton').innerText()).includes('确认'));
  await row.locator('.threadDeleteButton').click();await row.waitFor({state:'detached'});await stays();assert.equal(deletes,1);
  await group.locator('.projectDeleteButton').click();await stays();assert.equal(deletes,1,'Workspace delete also needs a second explicit click');
  await group.locator('.projectDeleteButton').click();await group.waitFor({state:'detached'});await stays();assert.equal(deletes,2);
  for(const [trigger,dialog,close] of [
   ['.v2PrimaryNav>button:nth-child(1)','.newThreadProjectPicker','button[aria-label="关闭"]'],
   ['.v2SidebarSearchButton','.globalSearchDialog','button[aria-label="关闭搜索"]'],
   ['.v2PrimaryNav>button:nth-child(2)','.skillPickerPopover','.skillPickerClose']
  ]){await sidebarOpen();await sidebar.locator(trigger).click();await page.locator(dialog).waitFor();await page.waitForTimeout(400);assert.equal(await sidebar.evaluate(e=>e.classList.contains('collapsed')),mobile,'Only mobile external navigation dismisses the drawer');await page.locator(dialog).locator(close).click();await page.locator(dialog).waitFor({state:'hidden'});}
  await sidebarOpen();
  if(mobile){await page.locator('.mobileRightWorkspaceToggle').evaluate(e=>e.click());await page.waitForTimeout(450);assert.equal(await sidebar.evaluate(e=>e.classList.contains('collapsed')),true);await page.locator('.rightWorkspace.isOpen').getByRole('button',{name:'隐藏右栏',exact:true}).click();}
  if(mobile){await sidebarOpen();await sidebar.locator('.v2SidebarToggle').click();await page.waitForTimeout(400);}
  const composer=page.locator('.conversation>.composer'),editor=composer.locator('[contenteditable=true]').first();
  // The same activity classes used by GoalProgress/SubagentActivity and an
  // uploaded-file list, including their outer layout boundaries.
  await composer.evaluate(element=>{
   const strip=document.createElement('div');strip.className='queuedSubmissionStrip';strip.dataset.qaFold='';strip.textContent='排队消息检查';element.append(strip);
   const activity=element.querySelector('.composerThreadActivity');
   for(const label of ['子代理活动','子代理历史','持续目标']){const section=document.createElement('section');section.dataset.qaFold='';section.className='threadActivityStrip';section.style.minHeight='36px';section.textContent=label;activity.append(section);}
   const action=document.createElement('button');action.type='button';action.dataset.qaActivityAction='';action.textContent='查看目标详情';action.onclick=()=>{window.qaActivityClicks=(window.qaActivityClicks??0)+1;};activity.append(action);
   const upload=document.createElement('div');upload.dataset.qaFold='';upload.className='uploadedFileList';upload.textContent='fixture.txt';element.querySelector('.composerBody').append(upload);
  });
  await editor.fill('保留的多行草稿\n第二行内容');await page.waitForTimeout(250);const draft=await editor.innerText();
  await editor.evaluate(e=>e.blur());await page.waitForTimeout(650);
  const compactHeight=(await composer.boundingBox()).height;
  const preview=await editor.evaluate(e=>{const shell=e.closest('.composerRichEditor'),range=document.createRange();range.selectNodeContents(e.firstElementChild);const text=range.getBoundingClientRect(),box=shell.getBoundingClientRect();return{scrollTop:shell.scrollTop,overflow:getComputedStyle(shell).overflowY,mask:getComputedStyle(shell).maskImage,top:text.top-box.top,bottom:text.bottom-box.top,height:box.height};});
  if(mobile){assert.equal(preview.overflow,'clip','Legacy mobile overflow-y:auto!important must not re-enable capsule scrolling');assert.equal(preview.scrollTop,0);assert.ok(preview.mask.includes('to right'),'One-line preview fades horizontally, not across the whole line');assert.ok(preview.top>=-1&&preview.bottom<=preview.height+1,'The first preview line must be fully readable');}
  if(mobile){assert.ok(compactHeight<=56,'Activity, attachments and a draft must still start as one capsule');for(const item of await composer.locator('[data-qa-fold]').all())assert.equal(await item.isVisible(),await item.evaluate(e=>e.classList.contains('queuedSubmissionStrip')),'Only the queued message stays visible above the capsule');}
  else{assert.ok(compactHeight>60);for(const item of await composer.locator('[data-qa-fold]').all())assert.equal(await item.isVisible(),true);}
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.QA_SCREENSHOT_DIR,`${width}-${theme}-compact.png`)});
  if(mobile){
   await composer.locator('.v2ComposerPlus').tap();await page.locator('#v2PlusMenu').waitFor();await page.waitForTimeout(300);
   for(const item of await composer.locator('[data-qa-fold]').all())assert.equal(await item.isVisible(),true,'A real capsule action must also expand retained activity');
   await composer.locator('.v2ComposerPlus').tap();await page.locator('#v2PlusMenu').waitFor({state:'hidden'});await page.waitForTimeout(700);
   assert.ok((await composer.boundingBox()).height<=56);assert.equal(await editor.innerText(),draft);
  }
  await editor.focus();await page.waitForTimeout(450);assert.ok((await composer.boundingBox()).height>60);
  for(const item of await composer.locator('[data-qa-fold]').all())assert.equal(await item.isVisible(),true,'Expanded activity must be restored, not discarded');
  assert.equal(await editor.innerText(),draft);
  if(process.env.QA_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.QA_SCREENSHOT_DIR,`${width}-${theme}-expanded.png`)});
  if(mobile){await composer.locator('[data-qa-activity-action]').tap();await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>window.qaActivityClicks),1);assert.ok((await composer.boundingBox()).height>60,'Inline controls must not close the activity while dismissing the keyboard');await page.locator('.mobileHeaderTitle').tap();}
  else await editor.evaluate(e=>e.blur());
  await page.waitForTimeout(450);
  if(mobile){
   await composer.evaluate(e=>{const box=document.createElement('section');box.id='qa-critical';box.className='codexApprovalRequests';box.style.minHeight='50px';box.textContent='必须可见的批准确认';e.append(box);});await page.waitForTimeout(400);
   assert.ok((await composer.boundingBox()).height>60,'Permission and destructive confirmations must never be hidden by compact mode');await page.locator('#qa-critical').evaluate(e=>e.remove());
  }
  assert.deepEqual(await page.evaluate(()=>window.mobileQaSocket.requests.filter(t=>/^turn\.(start|interrupt)$|^turn\.queue\.(?!list$)|^thread\.create$/.test(t))),[]);
  reports.push({width,theme,localActionsStay:true,confirmationBeforeDelete:true,externalDismiss:mobile,activityRetained:true,draftRetained:true,compactHeight,preview,productionWrites:0,fixtureDeletes:deletes});console.log(JSON.stringify({passed:reports.at(-1)}));await context.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({reports,errors,productionWrites:0}));
}finally{await browser.close();}
