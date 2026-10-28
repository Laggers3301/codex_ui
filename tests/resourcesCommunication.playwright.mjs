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
  const diskTip = a.locator('.hostResourceSummary .hostResourceDisk');
  await diskTip.hover(); await expect(diskTip).toHaveAttribute("title", /挂载路径：\/\n系统：\/\n数据目录：\/fixture\/data/);
  await expect(resourcePanel.getByText("vda", { exact: true })).toHaveAttribute("title", "挂载路径（含分区）：/、/boot");
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
  assert.equal((await state()).networkProbes, 0, "resource polling never runs ping automatically");
  const dockPing = a.locator('.hostResourceDock').getByRole("button", { name: "ping google.com", exact: true });
  const dockStatsBox = await a.getByRole("button", { name: "查看主机资源", exact: true }).boundingBox(), pingBox = await dockPing.boundingBox();
  assert.ok(dockStatsBox.x + dockStatsBox.width <= pingBox.x + 1 && Math.abs(dockStatsBox.y + dockStatsBox.height / 2 - pingBox.y - pingBox.height / 2) < 1, "ping stays alongside CPU, memory and disk in the same row");
  await context.request.post(origin + "/api/__test/network-mode", { data: { hold: true, fail: false } });
  await dockPing.click(); await expect(dockPing).toBeDisabled();
  const network = resourcePanel.getByRole("article", { name: "主机网络检测", exact: true });
  await expect(network).toContainText("正在发送 3 次 ICMP 探测");
  await expect(resourcePanel.getByRole("button", { name: "ping google.com", exact: true })).toBeDisabled();
  await context.request.post(origin + "/api/__test/network-mode", { data: { hold: false } });
  await expect(network).toContainText("平均延迟 20.5 ms · 丢包 0%"); await expect(dockPing).toBeEnabled();
  await context.request.post(origin + "/api/__test/network-mode", { data: { fail: true } });
  await resourcePanel.getByRole("button", { name: "ping google.com", exact: true }).click();
  await expect(network).toContainText("本次检测未收到 ICMP 应答。");
  const pingOutput = network.locator("pre"); await expect(pingOutput).toContainText("100% packet loss");
  const readsBeforeError = resourceTimes.length;
  await pingOutput.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await expect.poll(() => resourceTimes.length).toBeGreaterThan(readsBeforeError);
  assert.match(await a.evaluate(() => getSelection().toString()), /100% packet loss/, "diagnostics remain selectable during resource refresh");
  assert.equal((await state()).networkProbes, 2, "only the two manual clicks run network probes");
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
    await expect(panel.getByRole("button", { name: /^(订阅话题|取消订阅|注册服务提供者|注册任务提供者|注销提供者)$/ })).toBeEnabled(); return panel;
  };
  const b = await create("main-b"), panelA = await openCommunication(a);
  let panelB = await openCommunication(b);
  await panelB.getByLabel("话题名称", { exact: true }).fill("/status"); await panelB.getByRole("button", { name: "订阅话题", exact: true }).click();
  await expect(panelB.getByRole("button", { name: "取消订阅", exact: true })).toBeVisible();
  await panelA.getByLabel("话题名称", { exact: true }).fill("/status"); await panelA.getByRole("textbox", { name: "广播内容", exact: true }).fill("状态消息 42"); await panelA.getByRole("button", { name: "发布消息", exact: true }).click();
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
  assert.equal((await state()).starts.length, 0, "communication never launches a model turn or a process");
  await a.setViewportSize({ width: 1600, height: 1000 });
  await expect(panelA.getByRole("option", { name: "侧边会话（尚未创建）", exact: true })).toHaveAttribute("disabled", "");
  await expect(panelA.getByLabel("模型通信工具状态", { exact: true })).toContainText("本轮尚未检测到");
  // Load the main/side tools through the real socket resume/fork paths. Only
  // the independent fixture's model execution is simulated.
  await editor.fill("注册主会话通信工具"); await editor.press("Enter");
  await expect.poll(async () => (await state()).starts.length).toBe(1);
  await context.request.post(origin + "/api/__test/complete", { data: { threadId: "main-a" } });
  await panelA.getByRole("button", { name: "检查工具", exact: true }).click();
  await expect(panelA.getByLabel("模型通信工具状态", { exact: true })).toContainText("已注册 session_communication");
  const quote = "第一段正文用于主会话 A 的侧边提问。";
  await a.locator("#conversation-messages").getByText(quote, { exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
  });
  await a.getByRole("button", { name: "在侧边提问", exact: true }).click();
  await openCommunication(a);
  await expect(panelA.getByRole("option", { name: "侧边会话（首次发送后可用）", exact: true })).toHaveAttribute("disabled", "");
  await a.getByRole("tab", { name: "侧边聊天", exact: true }).click();
  const sidePanel = a.getByRole("complementary", { name: "临时侧边对话", exact: true });
  const sideEditor = sidePanel.locator('[contenteditable="true"]');
  await sideEditor.fill("为通信测试创建侧边会话"); await sideEditor.press("Enter");
  await expect.poll(async () => (await state()).sides.find(side => side?.parentThreadId === "main-a")?.threadId).toBeTruthy();
  const side = (await state()).sides.find(side => side?.parentThreadId === "main-a");
  await context.request.post(origin + "/api/__test/complete", { data: { threadId: side.threadId } });
  await openCommunication(a);
  await panelA.getByRole("tab", { name: "Topic 话题", exact: true }).click();
  await panelA.getByLabel("话题名称", { exact: true }).fill("/main-draft");
  await panelA.getByRole("textbox", { name: "广播内容", exact: true }).fill("主会话独立草稿");
  await panelA.getByLabel("通信身份", { exact: true }).selectOption("side");
  await expect(panelA.getByLabel("话题名称", { exact: true })).toHaveValue("/updates");
  await expect(panelA.getByLabel("模型通信工具状态", { exact: true })).toContainText("已注册 session_communication");
  const modelCall = async (threadId, command) => {
    const response = await context.request.post(origin + "/api/__test/model-communication", { data: { threadId, command } });
    assert.equal(response.status(), 200); const rpc = await response.json();
    assert.equal(rpc.result?.isError, false, JSON.stringify(rpc.error ?? rpc.result));
    return JSON.parse(rpc.result.content[0].text);
  };
  assert.equal((await modelCall(side.threadId, { operation: "read" })).threadId, side.threadId, "a fork's tool credential resolves to the side identity");
  assert.equal((await modelCall("main-a", { operation: "read" })).threadId, "main-a");
  await modelCall(side.threadId, { operation: "topic.subscribe", name: "/main-side", requestId: "side-model-subscribe" });
  await modelCall("main-a", { operation: "topic.publish", name: "/main-side", message: "主会话通过工具发送到侧边", requestId: "main-model-publish" });
  await expect(panelA.locator(".communicationMessage")).toContainText("主会话通过工具发送到侧边");
  assert.ok((await modelCall(side.threadId, { operation: "read" })).inbox.some(message => message.message === "主会话通过工具发送到侧边"));
  assert.ok(!(await modelCall("main-a", { operation: "read" })).inbox.some(message => message.message === "主会话通过工具发送到侧边"), "an unsubscribed main thread never receives its side's topic inbox");
  await modelCall(side.threadId, { operation: "service.advertise", name: "/main-side-service", requestId: "side-model-advertise" });
  const request = await modelCall("main-a", { operation: "service.call", name: "/main-side-service", message: "请侧边核对结果", timeoutSeconds: 120, requestId: "main-model-service-call" });
  await modelCall(side.threadId, { operation: "service.respond", id: request.id, result: "侧边通过工具返回核对结果", success: true, requestId: "side-model-service-response" });
  assert.equal((await modelCall("main-a", { operation: "get", id: request.id })).result, "侧边通过工具返回核对结果");
  await panelA.getByRole("textbox", { name: "广播内容", exact: true }).fill("侧边独立草稿");
  await panelA.getByLabel("通信身份", { exact: true }).selectOption("main");
  await expect(panelA.getByLabel("话题名称", { exact: true })).toHaveValue("/main-draft");
  await expect(panelA.getByRole("textbox", { name: "广播内容", exact: true })).toHaveValue("主会话独立草稿");
  await panelA.getByLabel("通信身份", { exact: true }).selectOption("side");
  await expect(panelA.getByRole("textbox", { name: "广播内容", exact: true })).toHaveValue("侧边独立草稿");
  const statusPath = `**/api/projects/${meta.projectId}/threads/${side.threadId}/mcp-status`;
  await a.route(statusPath, route => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "thread not found: fixture-unloaded" }) }));
  await panelA.getByRole("button", { name: "检查工具", exact: true }).click();
  await expect(panelA.getByLabel("模型通信工具状态", { exact: true })).toContainText("暂时无法确认");
  await panelA.getByText("查看工具状态错误", { exact: true }).click();
  await expect(panelA).toContainText("thread not found: fixture-unloaded");
  await expect(panelA.locator(".communicationMessage")).toContainText("主会话通过工具发送到侧边");
  await a.unroute(statusPath); await panelA.getByRole("button", { name: "检查工具", exact: true }).click();
  await expect(panelA.getByLabel("模型通信工具状态", { exact: true })).toContainText("已注册 session_communication");
  const statusChecks = (await state()).calls.filter(call => call.method === "mcpServerStatus/list").length;
  await a.waitForTimeout(5500);
  assert.equal((await state()).calls.filter(call => call.method === "mcpServerStatus/list").length, statusChecks, "inbox polling never repeatedly queries native tool status");
  await a.screenshot({ path: `${evidence}/communication-main-side.png` });
  await a.setViewportSize({ width: 393, height: 852 });
  assert.ok(await panelA.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await a.setViewportSize({ width: 1600, height: 1000 });
  await a.locator('[data-thread-id="main-b"] .threadSelectButton').click(); await openCommunication(a);
  await expect(panelA.getByLabel("通信身份", { exact: true })).toHaveValue("main");
  await expect(panelA.getByRole("option", { name: "侧边会话（尚未创建）", exact: true })).toHaveAttribute("disabled", "");
  await a.locator('[data-thread-id="main-a"] .threadSelectButton').click();
  await expect(a.getByRole("tab", { name: "侧边聊天", exact: true })).toHaveAttribute("aria-selected", "true");
  await openCommunication(a); await panelA.getByLabel("通信身份", { exact: true }).selectOption("side");
  await expect(panelA.getByRole("textbox", { name: "广播内容", exact: true })).toHaveValue("侧边独立草稿");
  await expect(panelA.locator(".communicationMessage")).toContainText("主会话通过工具发送到侧边");
  const finalState = await state(); assert.equal(finalState.starts.length, 2, "only the two explicit simulated user messages start turns"); assert.deepEqual(errors, []);
  const report = { isolatedDatabase: true, realRestAndWebsocket: true, resourceSamplingAboutTwoSeconds: intervals, hiddenPageStopsPolling: true, resourceRefreshPreservesCaret: true, failuresPreserveLastResourceData: true, mountPathsOnHover: true, pingInSameRow: true, manualPingOnly: true, pingLatencyAndFailureOutput: true, pingOutputRemainsSelectable: true, topicDeliveryAndReload: true, concurrentServicesRemainIndependent: true, serviceErrorsCorrelated: true, actionFeedbackAndCancelAck: true, mainSideIdentityAndDraftIsolation: true, realMcpWithSocketResumeAndForkCredentials: true, mainSideTopicAndServiceToolCalls: true, unsubscribedMainReceivesNoTopic: true, toolStatusFailureKeepsInbox: true, toolStatusNotPolled: true, phoneNoHorizontalOverflow: true, communicationNeverStartsModelTurns: true, simulatedUserTurns: 2, errors };
  await fs.writeFile(`${evidence}/results.json`, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) ?? []).entries()) {
    await page.screenshot({ path: `${evidence}/failure-${index}.png` }).catch(() => {});
    await fs.writeFile(`${evidence}/failure-${index}.html`, await page.content()).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) { if (child.exitCode !== null) continue; const closed = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await closed; }
}
