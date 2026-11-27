import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import {chromium,expect} from "@playwright/test";
import {setContentViewport} from "./contentViewport.mjs";

const children=[],errors=[],branches=[];
const evidence=process.env.MIGRATION_EVIDENCE??"output/qa/migration-recovery";
let browser;
await fs.mkdir(evidence,{recursive:true});
function start(args,env={}) {
  const child=spawn(process.execPath,args,{env:{...process.env,...env},stdio:["ignore","pipe","pipe"]});
  children.push(child);child.stderr.on("data",chunk=>process.stderr.write(chunk));return child;
}
function ready(child,parse) {
  return new Promise((resolve,reject)=>{
    let output="";const timer=setTimeout(()=>reject(Error("Fixture startup timeout: "+output.slice(-800))),30000);
    child.stdout.on("data",chunk=>{output+=chunk;const value=parse(output);if(value){clearTimeout(timer);resolve(value);}});
    child.once("exit",code=>{clearTimeout(timer);reject(Error("Fixture exited: "+code));});
  });
}
try {
  const backend=start(["--import","tsx/esm","tests/boundSideChats.server.ts"],{MIGRATION_FIXTURE_TEST:"1"});
  const meta=await ready(backend,output=>output.split("\n").flatMap(line=>{try{const value=JSON.parse(line);return value.ready?[value]:[];}catch{return [];}})[0]);
  const vite=start(["--max-old-space-size=768","node_modules/vite/bin/vite.js","--config","tests/boundSideChats.vite.config.mjs"],{BOUND_SIDE_CHAT_TEST_BACKEND:meta.origin});
  await ready(vite,output=>output.includes("http://127.0.0.1:5212/"));
  const origin="http://127.0.0.1:5212";
  browser=await chromium.launch({headless:true,channel:process.env.MIGRATION_BROWSER_CHANNEL});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:"block"});
  assert.equal((await context.request.post(origin+"/api/auth/login")).status(),200);
  await context.addInitScript(project=>{
    localStorage.setItem("codex-web-user-id","admin");localStorage.setItem("codex-v2-project-admin",project);
    localStorage.setItem("codex-v2-expanded-projects-admin",JSON.stringify([project]));
  },meta.projectId);
  const post=async(name,data={})=>{const r=await context.request.post(origin+"/api/__test/"+name,{data});assert.ok(r.ok());return r.json();};
  const state=async()=>(await context.request.get(origin+"/api/__test/state")).json();
  const last=await post("interrupted-before-answer",{threadId:"main-a"});
  const page=await context.newPage();page.on("pageerror",error=>{errors.push(error.message);process.stderr.write(error.stack+"\n");});
  page.on("console",message=>{if(message.type()==="error")process.stderr.write("[browser] "+message.text()+"\n");});
  page.on("request",request=>{if(request.method()==="POST"&&new URL(request.url()).pathname.endsWith("/branch"))branches.push(request.postDataJSON());});
  await page.goto(`${origin}/?project=${meta.projectId}&thread=main-a`,{waitUntil:"domcontentloaded"});
  const tail=page.locator(`[data-turn-id="${last.turnId}"]`);
  await expect(tail).toContainText("中断在回答开始前的最后一轮");
  await expect(tail.getByRole("button",{name:"复制本次回答全部文字",exact:true})).toHaveCount(0);
  await tail.getByRole("button",{name:"选择账号并从此轮分支",exact:true}).click();
  const dialog=page.getByRole("dialog",{name:"选择分支目标"});
  await expect(dialog).toBeVisible();await dialog.getByRole("button",{name:"关闭",exact:true}).click();await expect(dialog).toHaveCount(0);
  await page.locator('[data-thread-id="main-a"] .threadSelectButton').click({button:"right"});
  await page.getByRole("menuitem",{name:"迁移会话",exact:true}).click();
  await expect(dialog).toContainText("迁移会话");
  await dialog.getByRole("button",{name:/目标账号/}).click();
  await expect(page.getByRole("option",{name:"ReClaude",exact:true})).toBeEnabled();
  await page.getByRole("option",{name:"GPT 0831",exact:true}).click();
  await dialog.getByRole("button",{name:/目标模型/}).click();
  await page.getByRole("option",{name:/6\.2/}).click();
  const branchReply=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname.endsWith("/branch"));
  await dialog.getByRole("button",{name:"创建并打开",exact:true}).click();
  await expect(dialog).toHaveCount(0);
  const notice=page.getByRole("status",{name:"会话迁移提示",exact:true});
  await expect(notice).toBeVisible();
  assert.equal(await notice.evaluate(element=>Boolean(element.closest(".threadNoticeStack"))),true);
  assert.equal(await page.locator("#conversation-messages").getByText("已创建迁移分支",{exact:false}).count(),0);
  assert.equal(branches.length,1);assert.equal(branches[0].turnId,last.turnId);
  assert.equal(branches[0].model,"gpt-6.2-sol");assert.equal(branches[0].targetAccountId,"260831");
  assert.equal((await state()).starts.length,0,"choosing a migration target must not run a model");
  const child=(await (await branchReply).json()).data.thread.id;assert.ok(child&&child!=="main-a");
  await page.locator('[data-thread-id="main-b"] .threadSelectButton').click();await expect(notice).toHaveCount(0);
  await page.locator(`[data-thread-id="${child}"] .threadSelectButton`).click();await expect(notice).toBeVisible();
  await setContentViewport(page,{width:393,height:852});
  const box=await notice.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=394&&box.y>=0&&box.y+box.height<852);
  await page.screenshot({path:evidence+"/phone-notice.png"});
  await setContentViewport(page,{width:1440,height:1000});
  const editor=page.locator('.composer:not(.temporaryAskComposer) [contenteditable="true"]').first();
  await post("fail-next");await editor.fill("第一次发送模拟失败");await editor.press("Enter");
  await expect(page.locator(".errorBanner")).toContainText("用于选中复制的完整错误详情");await expect(notice).toBeVisible();
  await editor.fill("继续迁移后的原任务");await editor.press("Enter");await expect(notice).toHaveCount(0);
  await expect.poll(async()=>(await state()).starts.length).toBe(1);

  await page.locator('[data-thread-id="main-a"] .threadSelectButton').click({button:"right"});
  await page.getByRole("menuitem",{name:"迁移会话",exact:true}).click();
  await dialog.getByRole("button",{name:/目标账号/}).click();
  await page.getByRole("option",{name:"ReClaude",exact:true}).click();
  const claudePost = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/branch"));
  const claudeStatus = page.waitForResponse(response => response.request().method() === "GET" && response.url().includes("/branch-status/"));
  await dialog.getByRole("button",{name:"创建并打开",exact:true}).click();
  assert.equal((await claudePost).status(), 202);
  const {data:{result}} = await (await claudeStatus).json();
  assert.equal(result.data.branchMode, "cross-runtime");
  assert.equal(result.data.sourceTurnId, last.turnId);
  const claudeChild = result.data.thread.id;
  assert.ok(claudeChild && claudeChild !== "main-a" && claudeChild !== child);
  await expect(dialog).toHaveCount(0);
  await expect(notice.getByRole("link", { name:"下载完整源记录" })).toHaveAttribute("href", result.data.historySourceUrl);
  await notice.getByText("迁移说明", { exact:true }).click();
  await expect(notice).toContainText("已保留中断轮次的用户消息");
  await expect(page.locator("#conversation-messages")).toContainText("中断在回答开始前的最后一轮");
  assert.equal(branches.length, 2);
  assert.equal(branches[1].turnId, last.turnId);
  assert.equal(branches[1].model, "reclaude-sonnet@1");
  assert.equal(branches[1].background, true);
  assert.ok(branches[1].operationId);
  assert.equal(branches[1].targetAccountId, undefined);
  assert.equal((await state()).starts.length, 1, "creating a ReClaude branch must not send a model turn");
  await editor.fill("继续 ReClaude 迁移后的任务");
  await editor.press("Enter");
  await expect(notice).toHaveCount(0);
  await expect.poll(async() => (await state()).starts.at(-1)).toMatchObject({
    threadId: claudeChild, model: "reclaude-sonnet@1", text: "继续 ReClaude 迁移后的任务"
  });

  assert.deepEqual(errors,[]);
  const checks={isolatedDatabase:true,interruptedTurnBranch:true,contextMenuGptModel:true,crossRuntimeReClaude:true,originalTurnSelected:true,branchWithoutModelTurn:true,noticeAtTop:true,noticeIsolatedByThread:true,noticeRetainedOnFailure:true,noticeClearedOnAcceptedInput:true,phoneWithinViewport:true,errors};
  await fs.writeFile(evidence+"/results.json",JSON.stringify(checks,null,2));console.log(JSON.stringify(checks,null,2));
} finally {
  await browser?.close();
  for(const child of children.reverse())if(child.exitCode===null){const exited=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGTERM");await exited;}
}
