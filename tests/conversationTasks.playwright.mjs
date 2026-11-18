import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium,expect} from '@playwright/test';
const vite=await createServer({configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0},logLevel:'error'});await vite.listen();
const origin=`http://127.0.0.1:${vite.httpServer.address().port}`,browser=await chromium.launch({headless:true}),results=[];
const output=process.env.CONVERSATION_TASKS_QA_OUTPUT||'output/qa/conversation-tasks';await fs.mkdir(output,{recursive:true});
try{
  for(const mobile of [false,true]){
    const context=await browser.newContext({viewport:mobile?{width:393,height:852}:{width:1440,height:1000},serviceWorkers:'block'});
    const errors=[],writes=[];let readsA=0,readsB=0;
    const tasks=[{id:'agent-a',kind:'agent',description:'检查接口',status:'running',background:true,lastToolName:'Read',summary:'正在检查接口',usage:{totalTokens:120,toolUses:3,durationMs:2000}},
      {id:'shell-a',kind:'shell',description:'运行测试',status:'running',background:true,summary:'测试已经启动'},
      {id:'shell-old',kind:'shell',description:'已结束的构建',status:'completed',background:true,summary:'构建成功'}];
    await context.route('**/api/**',route=>{
      if(route.request().method()!=='GET'){writes.push(route.request().method());return route.abort();}
      const pathname=new URL(route.request().url()).pathname;
      if(pathname.endsWith('/thread-a/tasks')){readsA++;return route.fulfill({json:{supported:true,data:tasks}});}
      if(pathname.endsWith('/thread-b/tasks')){readsB++;return route.fulfill({json:{supported:true,data:[{id:'shell-b',kind:'shell',description:'Bob 的任务',status:'completed',background:true,summary:'Bob 的结果'}]}});}
      return route.abort();
    });
    await context.routeWebSocket('**',socket=>socket.close());
    await context.addInitScript(()=>{window.__backgroundKeys=0;window.addEventListener('keydown',event=>{if(event.key==='Escape'||event.key==='Enter'&&event.ctrlKey)window.__backgroundKeys++;});});
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/tests/conversationTasks.html');
    const input=page.getByRole('textbox',{name:'任务输入'}),draft=await input.inputValue(),trigger=page.locator('.conversationTasksTrigger');
    await expect(trigger.locator('.conversationTasksCount')).toHaveText('2');const inputBox=await input.boundingBox(),triggerBox=await trigger.boundingBox();assert.ok(triggerBox.y>=inputBox.y+inputBox.height);
    await trigger.click();const dialog=page.getByRole('dialog',{name:'子代理与后台任务'}),list=page.getByLabel('会话任务列表');
    await expect(list.locator('.conversationTaskRow')).toHaveCount(4);await expect(list.getByRole('button',{name:/检查接口/})).toHaveCount(1);
    await dialog.getByRole('tab',{name:'后台任务',exact:true}).click();await expect(list.locator('.conversationTaskRow')).toHaveCount(2);
    await list.getByRole('button',{name:/运行测试/}).click();const detail=page.getByLabel('任务详情');await expect(detail).toContainText('测试已经启动');
    tasks[1]={...tasks[1],status:'completed',summary:'全部测试通过'};
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('codex:conversation-tasks',{detail:{userId:'alice',threadId:'thread-a'}})));
    await expect(detail).toContainText('全部测试通过');await expect(detail).toContainText('已完成');await expect(trigger.locator('.conversationTasksCount')).toHaveText('1');
    if(mobile)await detail.getByRole('button',{name:'返回任务列表'}).click();
    await dialog.getByRole('tab',{name:'子代理',exact:true}).click();await list.getByRole('button',{name:/检查接口/}).click();await expect(detail).toContainText('Read');
    await detail.getByRole('button',{name:'打开完整执行记录'}).click();await expect(dialog).toHaveCount(0);await expect(page.getByLabel('已打开的执行记录')).toHaveText('agent-a');
    await trigger.click();await dialog.getByRole('textbox',{name:'搜索会话任务'}).fill('不存在的任务');await expect(dialog).toContainText('没有匹配的任务');
    await page.keyboard.press('Control+Enter');await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);assert.equal(await page.evaluate(()=>window.__backgroundKeys),0);
    await expect(trigger).toBeFocused();assert.equal(await input.inputValue(),draft);
    await trigger.click();await page.evaluate(()=>window.changeTaskScope());await expect(dialog).toHaveCount(0);await page.locator('.conversationTasksTrigger').click();
    const bob=page.getByRole('dialog',{name:'子代理与后台任务'});await expect(bob).toContainText('Bob 的任务');await expect(bob).not.toContainText('检查接口');
    const before=readsB;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('codex:conversation-tasks',{detail:{userId:'alice',threadId:'thread-a'}})));await page.waitForTimeout(150);assert.equal(readsB,before);
    await bob.getByRole('button',{name:'关闭会话任务'}).click();await expect(bob).toHaveCount(0);await page.getByRole('button',{name:'切换运行引擎'}).click();
    const beforeCodex=readsB;await page.locator('.conversationTasksTrigger').click();const codex=page.getByRole('dialog',{name:'子代理',exact:true});await expect(codex).toContainText('当前会话暂无子代理');await expect(codex.getByRole('tab',{name:'后台任务'})).toHaveCount(0);assert.equal(readsB,beforeCodex);
    await codex.getByRole('button',{name:'关闭会话任务'}).click();await page.evaluate(()=>window.changeTaskScope());await page.getByRole('button',{name:'切换运行引擎'}).click();await page.locator('.conversationTasksTrigger').click();
    await expect(page.getByLabel('会话任务列表').locator('.conversationTaskRow')).toHaveCount(4);
    await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
    await page.screenshot({path:`${output}/${mobile?'phone':'desktop'}-list.png`});
    await page.getByLabel('会话任务列表').getByRole('button',{name:/已结束的构建/}).click();await expect(page.getByLabel('任务详情')).toContainText('构建成功');
    await page.screenshot({path:`${output}/${mobile?'phone':'desktop'}.png`});
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);results.push({mobile,taskTriggerVisible:true,agentDeduplicated:true,backgroundProgressUpdates:true,transcriptNavigation:true,scopeIsolation:true,codexCompatible:true,draftPreserved:true,keyboardDoesNotStopOrSend:true,errors});await context.close();
  }
}finally{await browser.close();await vite.close();}
const result={passed:true,cases:results,productionMutations:0,realModelRequests:0};await fs.writeFile(output+'/results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
