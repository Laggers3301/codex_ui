// Isolated browser acceptance: all conversation writes and WebSocket messages
// are mocked. No user thread is edited and no inference request is sent.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{chromium,webkit}=require('../node_modules/playwright');
const root=new URL('../',import.meta.url);
const out=new URL('output/qa/table-editing-20261019/',root);await fs.mkdir(out,{recursive:true});
const staticRoot=new URL('dist/',root).pathname;
const server=http.createServer(async(req,res)=>{
 try{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname),target=path.resolve(staticRoot,name==='/'?'index.html':'.'+name);
  if(!target.startsWith(staticRoot))throw new Error('outside static root');
  const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.json':'application/json','.svg':'image/svg+xml','.webp':'image/webp'}[path.extname(target)]??'application/octet-stream';
  const bytes=await fs.readFile(target);res.writeHead(200,{'Content-Type':mime});res.end(bytes);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));server.unref();
const base='http://127.0.0.1:'+server.address().port;
const project={id:'isolated-qa-project',userId:'qa-user',name:'隔离验收项目',rootPath:'/tmp/isolated-qa',defaultModel:'gpt-6.1-sol',defaultReasoningEffort:'xhigh',defaultSandbox:'danger-full-access',defaultApprovalPolicy:'never'};
const projects={data:[project],projectRoot:'/tmp/isolated-qa',threadContextFeatureEnabled:false};
const threadId='00000000-0000-4000-8000-000000001019';
const table='普通正文用于对照字号，中英文 Mixed 123。\n\n| 功能 | 说明 |\n| --- | --- |\n| 消息编辑 | '+'这是一段较长的中文说明，手机横向滑动查看，不应比正文更大。English and numbers 12345. '.repeat(5)+' |\n| 自动更新 | 已验证的稳定版本 |';
const fixture=()=>({id:threadId,sessionId:threadId,name:'表格和消息编辑隔离验收',preview:'表格和消息编辑隔离验收',cwd:project.rootPath,createdAt:1792380000,updatedAt:1792380000,status:{type:'idle'},turns:[1,2,3].map(n=>({id:'edit-turn-'+n,status:'completed',startedAt:1792380000+n,completedAt:1792380010+n,items:[{id:'u'+n,type:'userMessage',text:'原始问题 '+n+(n===2?'\n\n上传文件：\n- notes.txt: /tmp/qa-notes.txt':'')},{id:'a'+n,type:'agentMessage',text:n===3?table:'回答 '+n}]}))});
const results=[];
const engines=process.env.CODEX_QA_ENGINES?.split(',');
for(const [engine,type] of [['chromium',chromium],['webkit',webkit]].filter(([name])=>!engines||engines.includes(name))) {
 let browser;try{browser=await type.launch({headless:true});}catch(error){throw new Error(engine+' unavailable: '+error.message);}
 try{for(const mobile of [true,false]){
  let thread=fixture(),failEdit=false,failSend=false,edits=[],sends=[],sockets=0;
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile});
  await context.addInitScript(({projectId,thread})=>{localStorage.setItem('codex-web-user-id','qa-user');localStorage.setItem(`codex-v2-threads-qa-user-${projectId}`,JSON.stringify([thread]));},{projectId:project.id,thread});
  await context.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url()),pathname=url.pathname;
   if(pathname==='/api/users')return route.fulfill({json:{data:[{id:'qa-user',name:'qa-user'}],defaultUserId:'qa-user',lockedToLoginUser:true}});
   if(pathname==='/api/models')return route.fulfill({json:{data:[{id:'gpt-6.1-sol-xhigh',label:'gpt-6.1-sol',model:'gpt-6.1-sol',effort:'xhigh'}],defaultModel:'gpt-6.1-sol',defaultReasoningEffort:'xhigh'}});
   if(pathname==='/api/codex/account-pool')return route.fulfill({json:{data:{accounts:[],updatedAt:new Date().toISOString()}}});
   if(pathname==='/api/projects')return route.fulfill({json:{...projects,data:[project]}});
   if(pathname===`/api/projects/${project.id}/threads`)return route.fulfill({json:{data:[thread]}});
   if(pathname===`/api/threads/${threadId}`)return route.fulfill({json:{data:{thread},thread,history:{totalItems:thread.turns.length*2,returnedItems:thread.turns.length*2,before:0,nextBefore:0,hasOlder:false}}});
   if(pathname.endsWith('/edit-latest')){
    const body=req.postDataJSON();edits.push(body);
    if(failEdit)return route.fulfill({status:409,json:{error:'隔离测试：会话已更新'}});
    const i=thread.turns.findIndex(t=>t.id===body.turnId);assert(i>=0);
    thread={...thread,turns:thread.turns.slice(0,i)};
    return route.fulfill({json:{data:{thread:{id:threadId,turns:[]}}}});
   }
   if(pathname.endsWith('/files/preview'))return route.fulfill({json:{data:{name:'notes.txt',path:'/tmp/qa-notes.txt',relativePath:'notes.txt',size:12,mime:'text/plain',rawUrl:'/api/qa/notes',content:'附件内容'}}});
   if(pathname.endsWith('/context'))return route.fulfill({json:{data:{threadId,usedPercent:null,usedTokens:0,contextWindowTokens:500000,model:'gpt-6.1-sol',pin:{text:'',updatedAt:null},config:{},compactedAt:[]}}});
   if(pathname.includes(threadId))return route.fulfill({json:{data:[],goal:null}});
   // Fail closed on every other write, including composer prediction requests.
   if(req.method()!=='GET')return route.fulfill({status:409,json:{error:'QA prevents production writes'}});
   return route.fulfill({status:404,json:{error:'No isolated fixture for this API'}});
  });
  const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>console.log('pageerror',e.message));
  await page.routeWebSocket(/\/ws(?:\?|$)/,socket=>{
   sockets++;
   socket.send(JSON.stringify({type:'hello',ok:true,data:{pendingServerRequests:[],liveState:{activeTurns:[],agentMessages:[],toolItems:[],userMessages:[]},turnRecoveries:[],turnProgress:[]}}));
   socket.onMessage(raw=>{
    const message=JSON.parse(String(raw));
    if(message.type==='transport.ping'){socket.send(JSON.stringify({type:'transport.pong'}));return;}
    if(message.type==='turn.start'){
     sends.push(message);
     socket.send(JSON.stringify({type:'ack',requestId:message.requestId,ok:!failSend,error:failSend?'隔离测试：发送失败':undefined,data:{}}));
    }else socket.send(JSON.stringify({type:'ack',requestId:message.requestId,ok:true,data:{threadId:message.threadId,goal:null,data:[]}}));
   });
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  for(const name of ['展开项目侧栏','展开会话列表']){const b=page.getByRole('button',{name,exact:true});if(await b.isVisible())await b.click();}
  const projectButton=page.getByText('隔离验收项目',{exact:true}).filter({visible:true}).first();
  await projectButton.waitFor();
  const row=page.locator('.threadSelectButton').filter({hasText:'表格和消息编辑隔离验收'}).first();
  if(await projectButton.locator('xpath=ancestor::div[@aria-expanded][1]').getAttribute('aria-expanded')==='false')await projectButton.click({force:true});
  await page.waitForTimeout(1200);
  if(!await row.count())await page.getByRole('button',{name:'Refresh threads',exact:true}).click();
  await page.waitForTimeout(400);
  await page.screenshot({path:new URL(`${engine}-${mobile?'mobile':'desktop'}-before-thread.png`,out).pathname});
  await row.waitFor();await row.click({force:true});
  await page.locator('.markdownTable').waitFor();
  assert(sockets>0,'isolated WebSocket connected');
  await page.waitForTimeout(800);
  await page.screenshot({path:new URL(`${engine}-${mobile?'mobile':'desktop'}-opened.png`,out).pathname});
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.waitForTimeout(400);
   const metrics=await page.locator('.markdownTable').evaluate(table=>{
    const wrap=table.parentElement,cell=table.querySelector('td'),body=table.closest('.messageMarkdown');
    return {tableDisplay:getComputedStyle(table).display,cellFont:getComputedStyle(cell).fontSize,bodyFont:getComputedStyle(body).fontSize,supportsAdjust:CSS.supports('-webkit-text-size-adjust','100%')||CSS.supports('text-size-adjust','100%'),adjust:getComputedStyle(wrap).getPropertyValue('-webkit-text-size-adjust')||getComputedStyle(wrap).getPropertyValue('text-size-adjust'),cellWidth:cell.getBoundingClientRect().width,wrapWidth:wrap.clientWidth,scrollWidth:wrap.scrollWidth,pageOverflow:document.documentElement.scrollWidth>window.innerWidth+1};
   });
   assert.equal(metrics.tableDisplay,'table');assert.equal(metrics.cellFont,metrics.bodyFont);if(metrics.supportsAdjust)assert.equal(metrics.adjust,'100%');
   assert(metrics.cellWidth>=70);assert(!metrics.pageOverflow);if(mobile)assert(metrics.scrollWidth>metrics.wrapWidth);
   await page.locator('.markdownTableWrap').screenshot({path:new URL(`${engine}-${mobile?'mobile':'desktop'}-${theme}-table.png`,out).pathname});
   results.push({engine,mobile,theme,metrics});
  }
  const editor=page.locator('.composer .composerRichInput');
  const latest=page.locator('[data-turn-id="edit-turn-3"]');
  await latest.getByRole('button',{name:'编辑提问',exact:true}).click({force:true});
  assert.equal((await editor.innerText()).trim(),'原始问题 3');assert.equal(edits.length,0);
  assert(await latest.evaluate(e=>e.classList.contains('editingOriginalTurn')));
  await page.locator('.editingPromptNotice').getByRole('button',{name:'取消'}).click();
  assert.equal(edits.length,0);assert.equal((await editor.innerText()).trim(),'');
  const historical=page.locator('[data-turn-id="edit-turn-2"]');
  await historical.getByRole('button',{name:'编辑提问',exact:true}).click({force:true});
  await page.getByRole('checkbox',{name:'确认撤回此轮及后续问答'}).waitFor();
  assert.equal((await editor.innerText()).trim(),'原始问题 2');
  await page.locator('.composer').getByText('notes.txt',{exact:true}).waitFor();
  assert.match(await page.locator('.editingPromptNotice').innerText(),/后续 1 轮/);
  await page.locator('.composer').screenshot({path:new URL(`${engine}-${mobile?'mobile':'desktop'}-editing.png`,out).pathname});
  await editor.fill('修改后的问题');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.waitForTimeout(200);assert.equal(edits.length,0);
  await page.getByRole('checkbox',{name:'确认撤回此轮及后续问答'}).check();
  failEdit=true;
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.waitForTimeout(400);
  assert.equal(edits.length,1);
  assert.equal(sends.length,0);assert.equal((await editor.innerText()).trim(),'修改后的问题');
  assert.equal(thread.turns.length,3);
  failEdit=false;failSend=true;
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.waitForTimeout(700);
  if(sends.length!==1){await page.screenshot({path:new URL(`${engine}-${mobile?'mobile':'desktop'}-send-debug.png`,out).pathname});console.log(JSON.stringify({edits,sends,notices:await page.locator('[role="status"],.errorBanner,.providerFailureNotice').allTextContents()}));}
  assert.equal(sends.length,1);assert.equal(thread.turns.length,1);
  assert.equal((await editor.innerText()).trim(),'修改后的问题');
  assert.match(sends[0].prompt,/notes\.txt/);
  assert.deepEqual(edits.at(-1),{turnId:'edit-turn-2',expectedLatestTurnId:'edit-turn-3',allowHistoryRewrite:true});
  assert.equal(await page.locator('[data-turn-id="edit-turn-2"]').count(),0);
  assert.equal(await page.locator('[data-turn-id="edit-turn-3"]').count(),0);
  failSend=false;
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.waitForTimeout(500);assert.equal(edits.length,2);assert.equal(sends.length,2);
  assert.equal((await editor.innerText()).trim(),'');
  console.log(JSON.stringify({engine,mobile,editingPassed:true}));
  await context.close();
 }}finally{await browser.close();}
}
await fs.writeFile(new URL(engines?`results-${engines.join('-')}.json`:'results.json',out),JSON.stringify(results,null,2));
console.log(JSON.stringify({passed:true,tableChecks:results.length,editingChecks:'cancel, attachments, stale rejection, suffix removal, failed-send draft retention and retry',output:out.pathname}));
server.close();
