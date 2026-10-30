import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { setContentViewport } from "./contentViewport.mjs";

const children = [], errors = [], recoveryEvents=[];
let browser, page;
const start = (args, env = {}) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); child.stderr.on("data", chunk => process.stderr.write(chunk)); return child;
};
const ready = (child, parse) => new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error("fixture startup timeout: " + output.slice(-1000))), 30000);
  child.stdout.on("data", chunk => { output += chunk; const value = parse(output); if (value) { clearTimeout(timer); resolve(value); } });
  child.once("exit", code => { clearTimeout(timer); reject(new Error("fixture exited: " + code)); });
});
const evidence = "output/qa/turn-recovery-20261027";
await fs.mkdir(evidence, { recursive: true });
try {
  const backend = start(["--import", "tsx/esm", "tests/boundSideChats.server.ts"]);
  const meta = await ready(backend, output => output.split("\n").flatMap(line => { try { const item = JSON.parse(line); return item.ready ? [item] : []; } catch { return []; } })[0]);
  const vite = start(["--max-old-space-size=768", "node_modules/vite/bin/vite.js", "--config", "tests/boundSideChats.vite.config.mjs"], { BOUND_SIDE_CHAT_TEST_BACKEND: meta.origin });
  await ready(vite, output => output.includes("http://127.0.0.1:5212/"));
  const origin = "http://127.0.0.1:5212";
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"], serviceWorkers: "block" });
  await context.request.post(origin + "/api/auth/login");
  await context.addInitScript(project => {
    localStorage.setItem("codex-web-user-id", "admin");
    localStorage.setItem("codex-v2-project-admin", project);
    localStorage.setItem("codex-v2-expanded-projects-admin", JSON.stringify([project]));
  }, meta.projectId);
  page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  page.on('websocket',socket=>socket.on('framereceived',frame=>{try{const message=JSON.parse(String(frame.payload));if(message.type==='turn.recovery')recoveryEvents.push(message.data);}catch{}}));
  await page.goto(`${origin}/?project=${meta.projectId}&thread=main-a`, { waitUntil: "domcontentloaded" });
  await page.locator("#conversation-messages").getByText("第一段正文用于主会话 A 的侧边提问。", { exact: true }).waitFor();
  const post = name => context.request.post(origin + "/api/__test/" + name, { data: { threadId: "main-a" } });
  const state = async () => (await context.request.get(origin + "/api/__test/state")).json();
  const notice = page.getByRole("alert", { name: "本轮模型状态" });

  await post("start-main"); await post("open-tool"); await post("runtime-exit");
  await expect(notice.locator(".turnRecoveryMeta")).toContainText("运行进程退出");
  const incidentAt = await notice.locator("time").getAttribute("dateTime"); assert.ok(incidentAt);
  await notice.locator("summary").click();
  await expect(notice.locator("pre")).toContainText("SIGABRT");
  await notice.locator("pre").evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.mouse.move(500, 700);
  await page.waitForTimeout(9000);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "复制错误详情", exact: true }).click();
  await expect(notice.getByRole("button", { name: "已复制", exact: true })).toBeVisible();
  assert.ok((await page.evaluate(() => navigator.clipboard.readText())).includes("SIGABRT"));
  assert.equal((await state()).starts.length, 1, "waiting and copying must never restart a model");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-thread-id="main-a"] .threadSelectButton').click();
  await expect(notice.locator(".turnRecoveryMeta")).toContainText("运行进程退出");
  assert.equal(await notice.locator("time").getAttribute("dateTime"), incidentAt);
  await notice.getByRole("button", { name: "核对运行状态", exact: true }).click();
  await expect(notice.locator(".turnRecoveryInspection")).toContainText("未收到完成结果");
  const resume = notice.getByRole("button", { name: "沿用任务继续", exact: true });
  await expect(resume).toBeDisabled();
  assert.equal((await state()).starts.length, 1, "checking status is read-only");
  await notice.getByRole("checkbox").check(); await resume.click();
  await expect.poll(async () => (await state()).starts.length).toBe(2);
  const continuation = (await state()).starts[1].text;
  assert.ok(continuation.startsWith("请先核对上一轮") && continuation.includes("不重新开始整个任务"));
  assert.ok(!continuation.includes("模拟主会话持续运行"), "continuing must not resend the original question");
  await expect(notice).toHaveCount(0);
  await post("complete");

  await post("start-main"); await post("interrupt-main");
  await expect(notice.locator(".turnRecoveryMeta")).toContainText("来源未确认");
  const layouts = [];
  for (const mobile of [false, true]) for (const theme of ["dark", "light"]) {
    await setContentViewport(page, mobile ? { width: 393, height: 852 } : { width: 1600, height: 1000 });
    const collapse=page.getByRole('button',{name:'折叠侧边栏',exact:true});
    if(mobile && await collapse.isVisible())await collapse.click();
    await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await notice.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const box = await notice.boundingBox(), viewport = page.viewportSize();
    assert.ok(box.x >= -1 && box.x + box.width <= viewport.width + 1, "the error notice fits the viewport");
    assert.ok(await notice.evaluate(element=>{const box=element.getBoundingClientRect();return element.contains(document.elementFromPoint(box.x+box.width/2,box.y+Math.min(12,box.height/2)));}), 'the error notice is above the mobile navigation');
    await page.screenshot({ path: `${evidence}/${mobile ? "phone" : "desktop"}-${theme}.png` });
    layouts.push({ mobile, theme, withinViewport: true });
  }

  await page.setViewportSize({ width: 1600, height: 1000 });
  await post("start-main");
  await page.getByRole("button", { name: "终止当前对话", exact: true }).click();
  await expect(notice.locator(".turnRecoveryMeta")).toContainText("主动停止");
  await notice.getByRole("button", { name: "关闭模型状态提示", exact: true }).click();
  await expect(notice).toHaveCount(0);
  const restored = await context.newPage(); restored.on("pageerror", error => errors.push(error.message));
  await restored.goto(`${origin}/?project=${meta.projectId}&thread=main-a`, { waitUntil: "domcontentloaded" });
  await restored.locator("#conversation-messages").getByText("第一段正文用于主会话 A 的侧边提问。", { exact: true }).waitFor();
  await expect(restored.getByRole("alert", { name: "本轮模型状态" })).toHaveCount(0);
  assert.deepEqual(errors, []);
  const report = { persistentBeyondEightSeconds: true, detailsSelectableAndCopyable: true, survivesReload: true, unknownToolsRequireReview: true, continuesWithoutReplayingPrompt: true, distinguishesRuntimeUserAndUnknown: true, dismissalSurvivesNewTab: true, layouts, errors };
  await fs.writeFile(evidence + "/results.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (page) {
    await page.screenshot({ path: evidence + "/failure.png" }).catch(() => {});
    console.error(JSON.stringify({errors,recoveryEvents:recoveryEvents.slice(-8),notice:await page.locator('.turnRecoveryBanner').count()}));
  }
  throw error;
} finally { await browser?.close(); for (const child of children.reverse()) child.kill("SIGTERM"); }
