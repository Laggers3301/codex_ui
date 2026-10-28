import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const children = [], errors = [], evidence = "output/qa/session-tasks";
let browser;
const start = (args, env = {}) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); child.stderr.on("data", chunk => process.stderr.write(chunk)); return child;
};
const ready = (child, parse) => new Promise((resolve, reject) => {
  let output = "";const timer = setTimeout(() => reject(new Error("fixture startup timeout: " + output.slice(-1000))), 30000);
  child.stdout.on("data", chunk => { output += chunk;const result = parse(output);if (result) { clearTimeout(timer); resolve(result); } });
  child.once("exit", code => { clearTimeout(timer); reject(new Error("fixture exited: " + code)); });
});
await fs.mkdir(evidence, { recursive: true });
try {
  const backend = start(["--import", "tsx/esm", "tests/boundSideChats.server.ts"]);
  const meta = await ready(backend, output => output.split("\n").flatMap(line => { try { const data = JSON.parse(line);return data.ready ? [data] : []; } catch { return []; } })[0]);
  const vite = start(["--max-old-space-size=768", "node_modules/vite/bin/vite.js", "--config", "tests/boundSideChats.vite.config.mjs"], { BOUND_SIDE_CHAT_TEST_BACKEND: meta.origin });
  await ready(vite, output => output.includes("http://127.0.0.1:5212/"));
  const origin = "http://127.0.0.1:5212";
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.request.post(origin + "/api/auth/login");
  await context.addInitScript(projectId => { localStorage.setItem("codex-web-user-id", "admin");localStorage.setItem("codex-v2-project-admin", projectId);localStorage.setItem("codex-v2-expanded-projects-admin", JSON.stringify([projectId])); }, meta.projectId);
  const state = async () => (await context.request.get(origin + "/api/__test/state")).json();
  const complete = async threadId => context.request.post(origin + "/api/__test/complete", { data: { threadId } });
  const create = async threadId => {
    const page = await context.newPage();page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/?project=${meta.projectId}&thread=${threadId}`, { waitUntil: "domcontentloaded" });
    await page.locator(`[data-thread-id="${threadId}"] .threadSelectButton`).click();return page;
  };
  const a = await create("main-a"), b = await create("main-b");
  const openTasks = async page => {
    if (!await page.locator(".rightWorkspace.isOpen").isVisible()) await page.locator(".topbar .rightWorkspaceToggle").click();
    await page.locator(".rightWorkspaceHome").click();await page.locator(".rightWorkspaceOverview").getByRole("button", { name: "会话通信", exact: true }).click();
    const panel = page.getByRole("region", { name: "会话通信", exact: true });
    await panel.getByRole("tab", { name: "直接任务", exact: true }).click();return panel;
  };
  let panel = await openTasks(a);
  await expect(panel.getByRole("option", { name: /主会话 B/ })).toBeAttached();
  await panel.getByRole("combobox", { name: "目标会话", exact: true }).selectOption("main-b");
  await panel.getByRole("textbox", { name: "派发任务", exact: true }).fill("普通会话 B 的独立任务");
  await panel.getByRole("button", { name: "派发并自动执行", exact: true }).click();
  const card = text => panel.locator("[data-task-id]").filter({ hasText: text });
  const first = card("普通会话 B 的独立任务");
  await expect(first).toContainText("执行中");await expect(b.locator("#conversation-messages")).toContainText("普通会话 B 的独立任务");
  await complete("main-b");await expect(first).toContainText("已交回来源会话");
  await expect(a.locator("#conversation-messages")).toContainText("已自动接收协作结果：");
  assert.equal(await a.locator('#conversation-messages .kind-user').count(), 0, "native result continuation never invents a user message");
  assert.equal((await state()).taskToolOutputs.length, 1);await complete("main-a");
  await a.reload({ waitUntil: "domcontentloaded" });await a.locator('[data-thread-id="main-a"] .threadSelectButton').click();panel = await openTasks(a);
  await expect(card("普通会话 B 的独立任务")).toContainText("已完成");assert.equal((await state()).taskToolOutputs.length, 1, "reloading never redelivers a result");

  const bEditor = b.locator('.conversation > .composer [contenteditable="true"]').first();
  await bEditor.fill("B 原来的工作仍在执行");await bEditor.press("Enter");
  await expect.poll(async () => (await state()).starts.length).toBe(3);
  await panel.getByRole("combobox", { name: "目标会话", exact: true }).selectOption("main-b");
  await panel.getByRole("checkbox", { name: "完成后自动回传并继续来源会话", exact: true }).uncheck();
  await panel.getByRole("textbox", { name: "派发任务", exact: true }).fill("这条排队任务将被取消");await panel.getByRole("button", { name: "派发并自动执行", exact: true }).click();
  await expect(card("这条排队任务将被取消")).toContainText("等待会话空闲");assert.equal((await state()).starts.length, 3);
  await card("这条排队任务将被取消").getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(card("这条排队任务将被取消")).toContainText("已取消");assert.equal((await state()).starts.length, 3);
  await panel.getByRole("textbox", { name: "派发任务", exact: true }).fill("B 空闲后自动执行这一条");await panel.getByRole("button", { name: "派发并自动执行", exact: true }).click();
  await expect(card("B 空闲后自动执行这一条")).toContainText("等待会话空闲");
  await complete("main-b");await expect(card("B 空闲后自动执行这一条")).toContainText("执行中");
  await complete("main-b");await expect(card("B 空闲后自动执行这一条")).toContainText("已完成");
  assert.equal((await state()).taskToolOutputs.length, 1, "the opt-out source is not automatically run");

  const aEditor = a.locator('.conversation > .composer [contenteditable="true"]').first();
  await aEditor.fill("A 继续自己的工作并调用通信工具");await aEditor.press("Enter");
  await expect.poll(async () => (await state()).starts.length).toBe(5);
  const modelCall = async command => {
    const response = await context.request.post(origin + "/api/__test/model-communication", { data: { threadId: "main-a", command } });
    assert.equal(response.status(), 200);const rpc = await response.json();assert.equal(rpc.result?.isError, false, JSON.stringify(rpc));return JSON.parse(rpc.result.content[0].text);
  };
  assert.ok((await modelCall({ operation: "task.targets", query: "主会话 C" })).some(target => target.threadId === "main-c"));
  const task = await modelCall({ operation: "task.send", targetThreadId: "main-c", message: "模型主动向普通会话 C 派发任务", requestId: "model-task-send-1" });
  await expect.poll(async () => (await modelCall({ operation: "task.get", id: task.id })).state).toBe("running");
  assert.equal((await state()).starts.length, 6);
  await complete("main-c");await expect.poll(async () => (await modelCall({ operation: "task.get", id: task.id })).callbackState).toBe("delivered");
  assert.equal((await state()).starts.length, 6, "an active source receives native tool output within its current turn");
  assert.equal((await state()).taskToolOutputs.length, 2);await complete("main-a");
  await expect(card("模型主动向普通会话 C 派发任务")).toContainText("已交回来源会话");
  await a.screenshot({ path: `${evidence}/existing-sessions-auto-task.png` });
  await a.setViewportSize({ width: 393, height: 650 });
  assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await panel.hover({ position: { x: 24, y: 100 } });await a.mouse.wheel(0, 700);
  await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await a.screenshot({ path: `${evidence}/tasks-phone.png` });
  const final = await state();assert.equal(final.calls.some(call => call.method === "thread/fork" || call.method === "thread/start"), false, "uses existing ordinary threads without spawning agents");assert.deepEqual(errors, []);
  const report = { isolatedDatabase: true, mockModelOnly: true, realRestWebsocketAndMcp: true, existingOrdinaryThreads: true, automaticExecutionAndNativeResultContinuation: true,
    noFabricatedSourceUserMessage: true, busyTargetQueued: true, queuedCancelDoesNotInterruptUserWork: true, autoStartAfterIdle: true,
    callbackOptOut: true, modelCanDiscoverAndDispatch: true, activeSourceGetsToolOutput: true, reloadKeepsResultWithoutReplay: true, phoneScrollAndNoOverflow: true, errors };
  await fs.writeFile(`${evidence}/results.json`, JSON.stringify(report, null, 2) + "\n");console.log(JSON.stringify(report, null, 2));
} catch (error) {
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) ?? []).entries()) {
    await page.screenshot({ path: `${evidence}/failure-${index}.png` }).catch(() => {});
    await fs.writeFile(`${evidence}/failure-${index}.html`, await page.content()).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) { if (child.exitCode !== null) continue;const closed = new Promise(resolve => child.once("exit", resolve));child.kill("SIGTERM");await closed; }
}
