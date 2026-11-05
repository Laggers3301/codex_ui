import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const children=[],errors=[];
let browser;
const evidence="output/qa/reclaude-preauth";
await fs.mkdir(evidence,{recursive:true});
const start=(args,env={})=>{
  const child=spawn(process.execPath,args,{env:{...process.env,...env},stdio:["ignore","pipe","pipe"]});
  children.push(child);child.stderr.on("data",chunk=>process.stderr.write(chunk));return child;
};
const ready=(child,parse)=>new Promise((resolve,reject)=>{
  let output="";const timer=setTimeout(()=>reject(new Error("Fixture startup timeout: "+output.slice(-1000))),30000);
  child.stdout.on("data",chunk=>{output+=chunk;const found=parse(output);if(found){clearTimeout(timer);resolve(found);}});
  child.once("exit",code=>{clearTimeout(timer);reject(new Error("Fixture exited: "+code));});
});
try {
  const backend=start(["--import","tsx/esm","tests/boundSideChats.server.ts"],{RECLAUDE_FIXTURE_TEST:"1"});
  const meta=await ready(backend,output=>output.split("\n").flatMap(line=>{try{const row=JSON.parse(line);return row.ready?[row]:[];}catch{return [];}})[0]);
  const vite=start(["--max-old-space-size=768","node_modules/vite/bin/vite.js","--config","tests/boundSideChats.vite.config.mjs"],{BOUND_SIDE_CHAT_TEST_BACKEND:meta.origin});
  await ready(vite,output=>output.includes("http://127.0.0.1:5212/"));
  const origin="http://127.0.0.1:5212";
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  await context.request.post(origin+"/api/auth/login");
  await context.addInitScript(project=>{
    localStorage.setItem("codex-web-user-id","admin");
    localStorage.setItem("codex-v2-project-admin",project);
    localStorage.setItem("codex-v2-expanded-projects-admin",JSON.stringify([project]));
  },meta.projectId);
  const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
  await page.route("**/api/codex/account-pool*",route=>route.fulfill({json:{data:{strategy:"most-remaining",accounts:["100001","100002","100003","100004"].map((id,i)=>({id,label:id,health:"ready",selectedForNewThreads:i===0,assignedThreadCount:0,quota:{rateLimits:{primary:{usedPercent:20,windowDurationMins:300,resetsAt:null}}}}))}}}));
  await page.route("**/api/codex/provider-quotas*",route=>route.fulfill({json:{data:{items:["mimo","ark"].map(id=>({id,name:id==="ark"?"Ark":"MiMo",status:"ready",periods:[{label:"weekly",usedPercent:20,resetsAt:null}],updatedAt:new Date().toISOString(),stale:false,message:null}))}}}));
  await page.route("**/api/reclaude/usage",route=>route.fulfill({json:{data:{thresholdPercent:99,accounts:[{orgId:"1",label:"fixture",state:"available",message:"fixture",windows:[{kind:"five_hour",percent:20,resetsAt:Date.now()+3600000,observedAt:Date.now(),source:"response"}],retryAfterSeconds:null}],creations:{limit:5,used:0,remaining:5,windowSeconds:3600,retryAt:null,retryAfterSeconds:0},monitoring:"response-events"}}}));
  const post=async(name,data={})=>{
    const response=await context.request.post(origin+"/api/__test/"+name,{data});assert.ok(response.ok(),await response.text());return response.json();
  };
  await page.goto(`${origin}/?project=${meta.projectId}&thread=main-a`,{waitUntil:"domcontentloaded"});
  await page.locator("#conversation-messages").getByText("第一段正文用于主会话 A 的侧边提问。",{exact:true}).waitFor();
  for(const mobile of [false,true]) {
    await page.setViewportSize(mobile?{width:393,height:852}:{width:1440,height:1000});
    const collapse=page.getByRole("button",{name:"折叠侧边栏",exact:true});if(mobile&&await collapse.isVisible())await collapse.click();
    if (mobile) await page.locator(".conversation > .composer .composerRichInput").click();
    await page.locator(".groupedModelPicker .polishedSelectTrigger").click();
    const dialog=page.getByRole("dialog",{name:"选择模型和推理档位"});
    await dialog.getByRole("button",{name:"Claude",exact:true}).click();
    await expect(dialog.getByRole("status")).toContainText("尚未连接 ReClaude");
    for(const family of ["Sonnet","Opus","Haiku"])await expect(dialog.getByRole("option",{name:`Claude ${family} 待连接`})).toBeDisabled();
    assert.ok(!await dialog.getByText(/Claude.*(xhigh|medium|high|max)/).count());
    const options=dialog.getByRole("option");
    for(const box of await options.evaluateAll(nodes=>nodes.map(n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom};}))) {
      assert.ok(box.x>=0&&box.right<=page.viewportSize().width+1&&box.y>=0&&box.bottom<=page.viewportSize().height+1,"Claude model options must stay inside viewport");
    }
    await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
    await page.screenshot({path:`${evidence}/${mobile?"phone":"desktop"}-claude-menu.png`});
    await page.locator(".groupedModelPicker .polishedSelectTrigger").click();
  }
  for(const mobile of [false,true]) {
    await page.setViewportSize(mobile?{width:393,height:852}:{width:1440,height:1000});
    const quota=page.locator(".quotaButton");
    if(mobile)await page.locator(".mobileHeaderTitle").click();
    await quota.dispatchEvent("click");
    const tabs=page.locator(".accountPoolTabs [role=tab]");await expect(tabs).toHaveCount(6);
    assert.deepEqual(await tabs.evaluateAll(nodes=>nodes.map(node=>node.getAttribute("data-account-id"))),["100001","100002","100003","100004","reclaude:1","provider:ark"]);
    await tabs.nth(4).click();await expect(page.getByRole("tabpanel",{name:"ReClaude 额度"})).toBeVisible();
    assert.ok(await page.locator(".accountPoolPopover").evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;}));
    await page.screenshot({path:`${evidence}/${mobile?"phone":"desktop"}-shared-quota.png`});
    await quota.dispatchEvent("click");
  }
  await page.setViewportSize({width:1440,height:1000});
  await post("claude-begin");
  const stream=event=>post("claude-event",{type:"stream_event",event});
  await post("claude-event",{type:"system",subtype:"init",session_id:"mock-only",model:"sonnet",tools:["Read","Bash"],skills:["pdf"],mcp_servers:[]});
  await stream({type:"message_start",message:{id:"msg-1"}});
  await stream({type:"content_block_start",index:0,content_block:{type:"text",text:""}});
  await stream({type:"content_block_delta",index:0,delta:{type:"text_delta",text:"已读取示例文件"}});
  await expect(page.locator("#conversation-messages")).toContainText("已读取示例文件");
  await stream({type:"content_block_delta",index:0,delta:{type:"text_delta",text:"，正在检查内容。"}});
  await stream({type:"content_block_stop",index:0});
  await post("claude-event",{type:"assistant",uuid:"snapshot-1",message:{id:"msg-1",content:[{type:"text",text:"已读取示例文件，正在检查内容。"},{type:"tool_use",id:"tool-1",name:"Read",input:{file_path:"demo.txt"}}]}});
  await post("claude-event",{type:"user",message:{content:[{type:"tool_result",tool_use_id:"tool-1",content:"示例文件内容：hello"}]}});
  await post("approval",{threadId:"main-a",kind:"claudeTool"});
  const approval=page.getByRole("alert",{name:"批准工具 Bash",exact:true});
  await expect(approval).toContainText("Claude 等待批准");await expect(approval).toContainText("git status --short");
  await page.screenshot({path:`${evidence}/desktop-claude-stream-approval.png`});
  await approval.getByRole("button",{name:"拒绝",exact:true}).click();await expect(approval).toHaveCount(0);
  await post("claude-event",{type:"result",subtype:"success",is_error:false,result:"已读取示例文件，正在检查内容。",session_id:"mock-only"});
  await expect(page.locator("#conversation-messages").getByText("已读取示例文件，正在检查内容。",{exact:true})).toHaveCount(1);
  await page.reload({waitUntil:"domcontentloaded"});
  const expand=page.getByRole("button",{name:"展开侧边栏",exact:true});
  if(await expand.isVisible())await expand.click();
  await page.locator('[data-thread-id="main-a"] .threadSelectButton').click();
  await expect(page.locator("#conversation-messages").getByText("已读取示例文件，正在检查内容。",{exact:true})).toHaveCount(1);
  const state=await (await context.request.get(origin+"/api/__test/state")).json();
  assert.equal(state.starts.length,0,"Neither model previews nor fixtures may start a native inference turn");
  assert.deepEqual(state.approvalResponses.at(-1).result,{decision:"decline"});
  assert.deepEqual(errors,[]);
  // Branch requests are intercepted; these clicks never create a native session.
  const branchBodies=[];
  await page.route("**/api/models",route=>route.fulfill({json:{data:[{id:"gpt-test",model:"gpt-6.1-sol",label:"GPT fixture",effort:"high"},{id:"gpt-max-test",model:"gpt-6.1-sol",label:"GPT fixture",effort:"max"},{id:"claude-test",model:"reclaude-sonnet@1",label:"Claude Sonnet · ReClaude",effort:"medium",availability:"ready",supportedEffortLevels:["medium","max"]},{id:"claude-max-test",model:"reclaude-sonnet@1",label:"Claude Sonnet · ReClaude",effort:"max",availability:"ready",supportedEffortLevels:["medium","max"]}]}}));
  await page.route("**/api/projects/*/threads/*/branch",async route=>{
    branchBodies.push(route.request().postDataJSON());
    await route.fulfill({json:{data:{thread:{id:"main-b",name:"分支 fixture",cwd:"/fixture",configuredModel:branchBodies.at(-1).model,turns:[]},sourceThreadId:"main-a",sourceTurnId:branchBodies.at(-1).turnId,turn:null,branchMode:"cross-runtime"}}});
  });
  for(const mobile of [false,true]){
    await page.setViewportSize(mobile?{width:393,height:852}:{width:1440,height:1000});
    await page.reload({waitUntil:"domcontentloaded"});
    const show=page.getByRole("button",{name:"展开侧边栏",exact:true});if(await show.isVisible())await show.click();
    await page.locator('[data-thread-id="main-a"] .threadSelectButton').click();
    const branch=page.getByRole("button",{name:"选择账号并从此回答分支",exact:true}).last();
    await branch.click();
    const dialog=page.getByRole("dialog",{name:"选择分支目标"});await dialog.waitFor();
    await dialog.getByRole("button",{name:/^目标账号/}).click();
    await page.getByRole("listbox",{name:"目标账号",exact:true}).getByRole("option",{name:mobile?"ReClaude":"100002",exact:true}).click();
    const chosen=mobile?"reclaude-sonnet@1":"gpt-6.1-sol";
    if(!mobile){await dialog.getByRole("button",{name:/^推理级别/}).click();await page.getByRole("listbox",{name:"推理级别",exact:true}).getByRole("option",{name:"max",exact:true}).click();}
    else {await dialog.getByRole("button",{name:/^推理级别/}).click();await page.getByRole("listbox",{name:"推理级别",exact:true}).getByRole("option",{name:"max",exact:true}).click();assert.ok(!(await dialog.getByRole("button",{name:/^目标模型/}).innerText()).includes("ReClaude"));}
    await dialog.evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
    assert.equal(await dialog.evaluate(node=>{const r=node.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+30)?.closest('[role="dialog"]')===node;}),true);
    assert.equal(await dialog.locator('select').count(),0);
    assert.equal(await dialog.evaluate(n=>getComputedStyle(n).fontSize),mobile?'15px':'14px');
    assert.equal(await page.locator('.branchTargetScrim').evaluate(n=>getComputedStyle(n).backdropFilter),'blur(5px)');
    for(const theme of ['light','dark']){
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.screenshot({path:`${evidence}/${mobile?"phone":"desktop"}-branch-${theme}.png`});
    }
    await page.screenshot({path:`${evidence}/${mobile?"phone":"desktop"}-branch-target.png`});
    await dialog.getByRole("button",{name:"创建并打开",exact:true}).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(branchBodies.at(-1).model,chosen);assert.equal(branchBodies.at(-1).reasoningEffort,"max");
    if(mobile){assert.equal(branchBodies.at(-1).targetAccountId,undefined);assert.match(branchBodies.at(-1).operationId,/^[a-f0-9-]{36}$/);}
    else {assert.equal(branchBodies.at(-1).targetAccountId,"100002");assert.equal(branchBodies.at(-1).reasoningEffort,"max");}
  }
  assert.equal(branchBodies.length,2);assert.deepEqual(errors,[]);
  const results={desktopAndPhoneMenus:true,unconnectedModelsDisabled:true,noFakeReasoningTiers:true,streamedTextVisible:true,fullSnapshotDeduplicated:true,nativeApprovalVisible:true,declineDelivered:true,reloadPreservesTimeline:true,nativeInferenceTurns:0,errors};
  await fs.writeFile(`${evidence}/results.json`,JSON.stringify(results,null,2)+"\n");console.log(JSON.stringify(results,null,2));
} finally {
  await browser?.close();
  for(const child of children.reverse()){
    if(child.exitCode!==null)continue;
    const done=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGTERM");
    await Promise.race([done,new Promise(resolve=>setTimeout(resolve,3000))]);
    if(child.exitCode===null)child.kill("SIGKILL");
  }
}
