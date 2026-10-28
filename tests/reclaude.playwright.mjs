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
  const post=async(name,data={})=>{
    const response=await context.request.post(origin+"/api/__test/"+name,{data});assert.ok(response.ok(),await response.text());return response.json();
  };
  await page.goto(`${origin}/?project=${meta.projectId}&thread=main-a`,{waitUntil:"domcontentloaded"});
  await page.locator("#conversation-messages").getByText("第一段正文用于主会话 A 的侧边提问。",{exact:true}).waitFor();
  for(const mobile of [false,true]) {
    await page.setViewportSize(mobile?{width:393,height:852}:{width:1440,height:1000});
    const collapse=page.getByRole("button",{name:"折叠侧边栏",exact:true});if(mobile&&await collapse.isVisible())await collapse.click();
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
