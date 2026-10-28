import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const children = [], errors = [], resourceTimes = [];
let browser;
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
const evidence = "output/qa/resources-communication-20261028";
await fs.mkdir(evidence, { recursive: true });
try {
  const backend = start(["--import", "tsx/esm", "tests/boundSideChats.server.ts"]);
  const meta = await ready(backend, output => output.split("\n").flatMap(line => { try { const item = JSON.parse(line); return item.ready ? [item] : []; } catch { return []; } })[0]);
  const vite = start(["--max-old-space-size=768", "node_modules/vite/bin/vite.js", "--config", "tests/boundSideChats.vite.config.mjs"], { BOUND_SIDE_CHAT_TEST_BACKEND: meta.origin });
  await ready(vite, output => output.includes("http://127.0.0.1:5212/"));
  const origin = "http://127.0.0.1:5212";
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.request.post(origin + "/api/auth/login");
  await context.addInitScript(project => {
    localStorage.setItem("codex-web-user-id", "admin"); localStorage.setItem("codex-v2-project-admin", project);
    localStorage.setItem("codex-v2-expanded-projects-admin", JSON.stringify([project]));
  }, meta.projectId);
  const state = async () => (await context.request.get(origin + "/api/__test/state")).json();
  const create = async thread => {
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/?project=${meta.projectId}&thread=${thread}`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-thread-id="${thread}"] .threadSelectButton`).click();
    return page;
  };
  const a = await create("main-a");
  a.on("request", request => { if (new URL(request.url()).pathname === "/api/system/resources") resourceTimes.push(Date.now()); });
  await a.getByRole("button", { name: "查看主机资源", exact: true }).click();
  const resourcePanel = a.getByRole("region", { name: "主机资源", exact: true });
  await expect(resourcePanel).toContainText("fixture-host"); await expect(resourcePanel).toContainText("每 2 秒更新");
  await expect(resourcePanel.getByRole("meter", { name: "CPU 使用率", exact: true })).toHaveAttribute("aria-valuenow", "13");
  await expect(resourcePanel).toContainText("6.0 GiB"); await expect(resourcePanel).toContainText("读取 2.0 MiB/s");
  const editor = a.locator('.conversation > .composer [contenteditable="true"]').first();
  await editor.fill("用于核对资源刷新的草稿"); await editor.press("ArrowLeft"); await editor.press("ArrowLeft");
  const caretBefore = await a.evaluate(() => ({ text: getSelection().anchorNode.textContent, offset: getSelection().anchorOffset }));
  await expect.poll(() => resourceTimes.length, { timeout: 10000 }).toBeGreaterThanOrEqual(3);
  const intervals = resourceTimes.slice(-3).slice(1).map((time, index) => time - resourceTimes.slice(-3)[index]);
  assert.ok(intervals.every(interval => interval >= 1750 && interval <= 3500), "visible resource sampling should be about two seconds apart");
  assert.deepEqual(await a.evaluate(() => ({ text: getSelection().anchorNode.textContent, offset: getSelection().anchorOffset })), caretBefore, "resource refresh must preserve the composer's caret");
  await a.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  const beforeHidden = resourceTimes.length; await a.waitForTimeout(2800); assert.equal(resourceTimes.length, beforeHidden, "hidden pages stop resource polling");
  await a.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => resourceTimes.length).toBeGreaterThan(beforeHidden);
  await context.request.post(origin + "/api/__test/resource-mode", { data: { fail: true } });
  await expect(resourcePanel).toContainText("更新失败", { timeout: 6000 }); await expect(resourcePanel).toContainText("6.0 GiB");
  await context.request.post(origin + "/api/__test/resource-mode", { data: { fail: false } });
  await resourcePanel.getByRole("button", { name: "刷新主机资源", exact: true }).click(); await expect(resourcePanel).not.toContainText("更新失败");
  await a.screenshot({ path: `${evidence}/resources-desktop-dark.png` });
  await a.setViewportSize({ width: 393, height: 852 }); await a.evaluate(() => document.documentElement.dataset.theme = "light");
  assert.ok(await resourcePanel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await a.screenshot({ path: `${evidence}/resources-phone-light.png` });
  await a.setViewportSize({ width: 1600, height: 1000 }); await a.evaluate(() => document.documentElement.dataset.theme = "dark");

  const openCommunication = async page => {
    if (!await page.locator(".rightWorkspace.isOpen").isVisible()) await page.locator(".topbar .rightWorkspaceToggle").click();
    await page.locator(".rightWorkspaceHome").click();
    await page.locator(".rightWorkspaceOverview").getByRole("button", { name: "会话通信", exact: true }).click();
    const panel = page.getByRole("region", { name: "会话通信", exact: true });
    await expect(panel.getByRole("button", { name: /^(订阅话题|取消订阅)$/ })).toBeEnabled(); return panel;
  };
  const b = await create("main-b"), panelA = await openCommunication(a);
  let panelB = await openCommunication(b);
  await panelB.getByLabel("话题名称", { exact: true }).fill("/status"); await panelB.getByRole("button", { name: "订阅话题", exact: true }).click();
  await expect(panelB.getByRole("button", { name: "取消订阅", exact: true })).toBeVisible();
  await panelA.getByLabel("话题名称", { exact: true }).fill("/status"); await panelA.getByLabel("广播内容", { exact: true }).fill("状态消息 42"); await panelA.getByRole("button", { name: "发布消息", exact: true }).click();
  await expect(panelB.locator(".communicationMessage")).toContainText("状态消息 42");
  await panelB.getByRole("button", { name: "标记已读", exact: true }).click(); await expect(panelB).toContainText("收件箱 · 0 未读");
  await b.reload({ waitUntil: "domcontentloaded" }); await b.locator('[data-thread-id="main-b"] .threadSelectButton').click(); panelB = await openCommunication(b);
  await expect(panelB).toContainText("状态消息 42"); await expect(panelB.getByRole("button", { name: "取消订阅", exact: true })).toBeVisible();

  await panelB.getByRole("tab", { name: "Service 服务", exact: true }).click(); await panelB.getByLabel("服务名称", { exact: true }).fill("/sum");
  await panelB.getByRole("button", { name: "注册服务提供者", exact: true }).click(); await expect(panelB.getByRole("button", { name: "注销提供者", exact: true })).toBeVisible();
  await panelA.getByRole("tab", { name: "Service 服务", exact: true }).click(); await panelA.getByLabel("服务名称", { exact: true }).fill("/sum");
  for (const text of ["1+1", "2+2"]) {
    await panelA.getByLabel("请求内容", { exact: true }).fill(text); await panelA.getByRole("button", { name: "发起请求", exact: true }).click(); await expect(panelA.getByLabel("请求内容", { exact: true })).toHaveValue("");
  }
  const first = panelB.locator(".communicationMessage").filter({ hasText: "1+1" }), second = panelB.locator(".communicationMessage").filter({ hasText: "2+2" });
  await expect(first).toBeVisible(); await expect(second).toBeVisible();
  await first.getByRole("textbox").fill("2"); await first.getByRole("button", { name: "返回结果", exact: true }).click();
  await expect(panelA.locator(".communicationMessage").filter({ hasText: "1+1" })).toContainText("已完成"); await expect(second).toContainText("等待接收");
  await second.getByRole("textbox").fill("用于验证相关联的错误结果"); await second.getByRole("button", { name: "返回错误", exact: true }).click();
  await expect(panelA.locator(".communicationMessage").filter({ hasText: "2+2" })).toContainText("用于验证相关联的错误结果");

  await panelB.getByRole("tab", { name: "Action 任务", exact: true }).click(); await panelB.getByLabel("任务名称", { exact: true }).fill("/work"); await panelB.getByRole("button", { name: "注册任务提供者", exact: true }).click();
  await expect(panelB.getByRole("button", { name: "注销提供者", exact: true })).toBeVisible();
  await panelA.getByRole("tab", { name: "Action 任务", exact: true }).click(); await panelA.getByLabel("任务名称", { exact: true }).fill("/work"); await panelA.getByLabel("任务目标", { exact: true }).fill("检查构建并持续反馈"); await panelA.getByRole("button", { name: "提交目标", exact: true }).click();
  const actionA = panelA.locator(".communicationMessage").filter({ hasText: "检查构建并持续反馈" }), actionB = panelB.locator(".communicationMessage").filter({ hasText: "检查构建并持续反馈" });
  await actionB.getByRole("button", { name: "接收任务", exact: true }).click();
  await actionB.getByRole("textbox").fill("完成一半"); await actionB.getByRole("spinbutton").fill("50"); await actionB.getByRole("button", { name: "反馈进度", exact: true }).click();
  await expect(actionA.getByRole("progressbar")).toHaveAttribute("value", "50");
  await actionA.getByRole("button", { name: "请求取消", exact: true }).click(); await expect(actionA).toContainText("已请求取消，等待确认");
  await actionB.getByRole("textbox").fill("已核对并停止该任务"); await actionB.getByRole("button", { name: "确认已取消", exact: true }).click();
  await expect(actionA).toContainText("已确认取消"); await expect(actionA).toContainText("已核对并停止该任务");
  await a.screenshot({ path: `${evidence}/communication-desktop-dark.png` });
  await a.setViewportSize({ width: 393, height: 852 }); await a.evaluate(() => document.documentElement.dataset.theme = "light");
  assert.ok(await panelA.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await a.screenshot({ path: `${evidence}/communication-phone-light.png` });
  const finalState = await state(); assert.equal(finalState.starts.length, 0, "communication never launches a model turn or a process"); assert.deepEqual(errors, []);
  const report = { isolatedDatabase: true, realRestAndWebsocket: true, resourceSamplingAboutTwoSeconds: intervals, hiddenPageStopsPolling: true, resourceRefreshPreservesCaret: true, failuresPreserveLastResourceData: true, topicDeliveryAndReload: true, concurrentServicesRemainIndependent: true, serviceErrorsCorrelated: true, actionFeedbackAndCancelAck: true, phoneNoHorizontalOverflow: true, noModelTurnsCreated: true, errors };
  await fs.writeFile(`${evidence}/results.json`, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  for (const child of children.reverse()) { if (child.exitCode !== null) continue; const closed = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await closed; }
}
