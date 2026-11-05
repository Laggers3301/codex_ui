import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
const children=[],results=[],errors=[];let browser;let authWrites=0,authPhase=null;
const out='output/qa/dialog-control-scale';await fs.mkdir(out,{recursive:true});
const start=(args,env={})=>{const p=spawn(process.execPath,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe']});children.push(p);p.stderr.on('data',b=>process.stderr.write(b));return p;};
const ready=(p,parse)=>new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Fixture startup timeout')),30000);p.stdout.on('data',b=>{text+=b;const result=parse(text);if(result){clearTimeout(timer);resolve(result);}});p.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture exited '+code));});});
try{
  const backend=start(['--import','tsx/esm','tests/boundSideChats.server.ts']);
  const meta=await ready(backend,s=>s.split('\n').flatMap(l=>{try{const v=JSON.parse(l);return v.ready?[v]:[];}catch{return[];}})[0]);
  const vite=start(['--max-old-space-size=768','node_modules/vite/bin/vite.js','--config','tests/boundSideChats.vite.config.mjs'],{BOUND_SIDE_CHAT_TEST_BACKEND:meta.origin});
  await ready(vite,s=>s.includes('http://127.0.0.1:5212/'));
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block'}),origin='http://127.0.0.1:5212';
  await context.request.post(origin+'/api/auth/login');
  await context.addInitScript(project=>{localStorage.setItem('codex-web-user-id','admin');localStorage.setItem('codex-v2-project-admin',project);localStorage.setItem('codex-v2-expanded-projects-admin',JSON.stringify([project]));},meta.projectId);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/codex/account-pool*',r=>r.fulfill({json:{data:{strategy:'highest-remaining-sticky-thread',updatedAt:new Date().toISOString(),accounts:[{id:'fixture-gpt',label:'Fixture GPT',health:'ready',selectedForNewThreads:true,assignedThreadCount:0,activeRequests:0,lastError:null,lastCheckedAt:null,quota:{rateLimits:{primary:{usedPercent:34,windowDurationMins:10080,resetsAt:1900000000},secondary:null}}}]}}}));
  await page.route('**/api/reclaude/usage',r=>r.fulfill({json:{data:{thresholdPercent:99,accounts:[{orgId:'1',label:'fixture',state:'available',message:'fixture',windows:[],retryAfterSeconds:null}],creations:{limit:5,used:0,remaining:5,windowSeconds:3600,retryAt:null,retryAfterSeconds:0},monitoring:'response-events'}}}));
  await page.route('**/api/reclaude/authorization',r=>r.fulfill({json:{data:{enabled:true,organizations:[{orgId:'1',label:'fixture',connected:true}],operation:authPhase?{id:'fixture-operation',orgId:'1',phase:authPhase,startedAt:Date.now(),expiresAt:Date.now()+300000,owned:true}:null}}}));
  await page.route('**/api/reclaude/authorization/*',r=>{authWrites++;return r.abort();});
  await page.route('**/api/system/select-directory',r=>r.fulfill({status:501,json:{error:'system-directory-picker-unavailable'}}));
  await page.route('**/api/system/directories*',r=>{const path=new URL(r.request().url()).searchParams.get('path')??'/workspace/demo';return r.fulfill({json:{data:{rootPath:'/workspace',currentPath:path,parentPath:'/workspace',directories:path==='/workspace/demo'?[{name:'alpha',path:path+'/alpha'},{name:'research-calibration-and-observations',path:path+'/research-calibration-and-observations'}]:[]}}});});
  const settle=()=>page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
  async function left(){if(!await page.locator('.v2AccountTrigger').isVisible())await page.getByRole('button',{name:'展开侧边栏',exact:true}).first().click();await page.locator('.v2AccountTrigger').waitFor();}
  async function control(locator,height,font){const s=await locator.evaluate(n=>{const c=getComputedStyle(n),r=n.getBoundingClientRect();return{height:r.height,font:c.fontSize,overflow:n.scrollWidth>n.clientWidth+1};});assert.ok(Math.abs(s.height-height)<1,JSON.stringify(s));assert.equal(s.font,font);assert.equal(s.overflow,false);}
  for(const width of [1440,393,320])for(const theme of ['light','dark']){
    const mobile=width<=720,h=mobile?44:36,font=mobile?'15px':'14px';
    await page.setViewportSize({width,height:900});
    await page.goto(`${origin}/?project=${meta.projectId}&thread=main-a`,{waitUntil:'domcontentloaded'});
    await page.locator('#conversation-messages').getByText('第一段正文用于主会话 A 的侧边提问。',{exact:true}).waitFor();
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    await left();await page.locator('.v2AccountTrigger').click();await page.getByRole('button',{name:'任务通知',exact:true}).click();
    const notification=page.getByRole('dialog',{name:'任务通知',exact:true});await notification.waitFor();await settle();
    await control(page.locator('.taskNotificationTest'),h,font);await control(notification.getByRole('button',{name:'关闭任务通知'}),h,font);
    await page.screenshot({path:`${out}/${width}-${theme}-notification.png`});
    await notification.getByRole('button',{name:'关闭任务通知'}).click();await notification.waitFor({state:'detached'});
    await left();await page.locator('.v2PrimaryNav').getByRole('button',{name:'插件',exact:true}).click();
    const skills=page.getByRole('dialog',{name:'选择 Codex 技能',exact:true});await skills.waitFor();await settle();
    for(const b of await page.locator('.skillPickerFooter button').all())await control(b,h,font);
    assert.equal(await page.locator('.skillPickerFooter>span').evaluate(n=>getComputedStyle(n).fontSize),'13px');
    assert.ok(await skills.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
    await page.screenshot({path:`${out}/${width}-${theme}-skills.png`});
    await page.getByRole('button',{name:'关闭技能选择器'}).click();await skills.waitFor({state:'detached'});
    await left();await page.locator('.v2PrimaryNav').getByRole('button',{name:'新建工作区',exact:true}).click();
    const directory=page.getByRole('dialog',{name:'选择项目目录',exact:true});await directory.waitFor();await page.locator('.directoryRow').first().waitFor();await settle();
    assert.equal(await page.locator('.directoryRow small').count(),0);
    assert.equal(await page.locator('.directoryRow').first().getAttribute('title'),'/workspace/demo/alpha');
    await expect(page.locator('.directoryCurrentPath')).toHaveText('/workspace/demo');
    await control(directory.getByRole('button',{name:'连接当前目录',exact:true}),h,font);
    await page.screenshot({path:`${out}/${width}-${theme}-directory.png`});
    await page.getByRole('button',{name:'打开 alpha，路径 /workspace/demo/alpha',exact:true}).click();
    await expect(page.locator('.directoryCurrentPath')).toHaveText('/workspace/demo/alpha');
    await directory.getByRole('button',{name:'取消',exact:true}).click();await directory.waitFor({state:'detached'});
    await page.getByRole('button',{name:'选择账号并从此回答分支',exact:true}).first().click();
    const branch=page.getByRole('dialog',{name:'选择分支目标',exact:true});await branch.waitFor();await settle();
    await control(branch.getByRole('button',{name:/^目标账号/}),h,font);await control(branch.getByRole('button',{name:'创建并打开',exact:true}),h,font);
    await page.screenshot({path:`${out}/${width}-${theme}-branch.png`});
    await branch.getByRole('button',{name:'关闭',exact:true}).click();await branch.waitFor({state:'detached'});
    // Account polling and App re-renders must not orphan keyed modal nodes.
    for(let attempt=0;attempt<Number(process.env.DIALOG_AUTH_CYCLES??5);attempt++){
      authPhase=attempt===3?'waiting_authorization':attempt===4?'failed':null;
      if(mobile)await page.locator('.mobileHeaderTitle:visible').click();
      await page.locator('.quotaButton:visible').click();
      await page.locator('.accountPoolTabs [role=tab]').first().click();
      await expect(page.getByRole('button',{name:'重新认证 ReClaude',exact:true})).toHaveCount(0);
      await page.getByRole('tab',{name:/ReClaude/}).click();
      await page.getByRole('button',{name:'重新认证 ReClaude',exact:true}).click();
      const auth=page.getByRole('dialog',{name:'ReClaude 重新认证',exact:true});await expect(auth).toHaveCount(1);
      await expect(auth.getByRole('button',{name:/^账号/})).toContainText('ReClaude');
      await settle();
      assert.equal(await page.locator('.reclaudeAuthScrim').count(),1);
      assert.equal(await auth.evaluate(n=>n.parentElement?.parentElement===document.body),true);
      await control(auth.getByRole('button',{name:'关闭重新认证',exact:true}),h,font);
      if(attempt===0)await page.screenshot({path:`${out}/${width}-${theme}-reauth.png`});
      if(attempt===1)await page.keyboard.press('Escape');
      else if(attempt===2)await page.locator('.reclaudeAuthScrim').click({position:{x:4,y:4}});
      else await auth.getByRole('button',{name:'关闭重新认证',exact:true}).click();
      await expect(auth).toHaveCount(0);await expect(page.locator('.reclaudeAuthScrim')).toHaveCount(0);
    }
    await page.evaluate(()=>{const section=document.createElement('section');section.className='exhaustedAccountNotice';section.style.top='70px';section.innerHTML='<p class="exhaustedAccountNoticeCopy">当前账号额度不足 10%，可分支到其他账号继续。</p><div class="exhaustedAccountNoticeActions"><button>分支</button><button>关闭</button></div>';document.querySelector('.conversation').append(section);});
    await settle();
    const notice=page.locator('.exhaustedAccountNotice');
    assert.ok(await notice.evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&n.scrollWidth<=n.clientWidth+1;}));
    assert.ok(await notice.evaluate(n=>{const r=n.getBoundingClientRect(),p=n.offsetParent.getBoundingClientRect();return Math.abs((r.left-p.left)-(p.right-r.right))<1&&r.width>p.width-60;}),'notice spans the conversation with equal side insets');
    await control(notice.getByRole('button',{name:'分支',exact:true}),mobile?44:36,font);
    await page.screenshot({path:`${out}/${width}-${theme}-quota.png`});
    await notice.evaluate(n=>n.remove());
    results.push({width,theme,controlHeight:h,font,directoryNavigationPreserved:true,noOverflow:true,reauthOpenCloseCycles:Number(process.env.DIALOG_AUTH_CYCLES??5)});
  }
  assert.deepEqual(errors,[]);assert.equal(authWrites,0);await fs.writeFile(`${out}/results.json`,JSON.stringify({results,errors,authWrites},null,2));console.log(JSON.stringify({results,errors,authWrites,nativeInferenceTurns:0}));
}finally{await browser?.close();for(const p of children.reverse()){if(p.exitCode!==null)continue;const done=new Promise(r=>p.once('exit',r));p.kill('SIGTERM');await Promise.race([done,new Promise(r=>setTimeout(r,3000))]);if(p.exitCode===null)p.kill('SIGKILL');}}
