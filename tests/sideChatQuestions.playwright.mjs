import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { setContentViewport } from "./contentViewport.mjs";

const children = [], errors = [], sent = [];
let browser, readState;
const evidence = process.env.SIDE_QUESTIONS_EVIDENCE ?? "output/qa/side-chat-questions";
await fs.mkdir(evidence, { recursive: true });
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
const panel = page => page.getByRole("complementary", { name: "临时侧边对话" });
const card = (page, title) => panel(page).locator(".toolQuestionCard").filter({ hasText: title });
const quote = "第一段正文用于主会话 A 的侧边提问。";
try {
  const backend = start(["--import", "tsx/esm", "tests/boundSideChats.server.ts"]);
  const meta = await ready(backend, output => output.split("\n").flatMap(line => { try { const value = JSON.parse(line); return value.ready ? [value] : []; } catch { return []; } })[0]);
  const vite = start(["--max-old-space-size=768", "node_modules/vite/bin/vite.js", "--config", "tests/boundSideChats.vite.config.mjs"], { BOUND_SIDE_CHAT_TEST_BACKEND: meta.origin });
  await ready(vite, output => output.includes("http://127.0.0.1:5212/"));
  const origin = "http://127.0.0.1:5212";
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  assert.equal((await context.request.post(origin + "/api/auth/login")).status(), 200);
  await context.addInitScript(projectId => {
    localStorage.setItem("codex-web-user-id", "admin"); localStorage.setItem("codex-v2-project-admin", projectId);
    localStorage.setItem("codex-v2-expanded-projects-admin", JSON.stringify([projectId]));
  }, meta.projectId);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => socket.on("framesent", ({ payload }) => { try { sent.push(JSON.parse(String(payload))); } catch {} }));
  const post = async (name, data = {}) => { const response = await context.request.post(origin + "/api/__test/" + name, { data }); assert.equal(response.status(), 200); return response.json(); };
  const state = async () => (await context.request.get(origin + "/api/__test/state")).json(); readState = state;
  const openMain = async id => page.locator(`[data-thread-id="${id}"] .threadSelectButton`).click();
  await page.goto(`${origin}/?project=${meta.projectId}&thread=main-a`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#conversation-messages").getByText(quote, { exact: true })).toBeVisible();
  await page.locator("#conversation-messages").getByText(quote, { exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "在侧边提问", exact: true }).click();
  const editor = panel(page).locator('[contenteditable="true"]');
  await editor.fill("验证侧边提问输入框"); await editor.press("Enter");
  await expect.poll(async () => (await state()).sides[0]?.status).toBe("running");
  const sideId = (await state()).sides[0].threadId;
  const question = async (itemId, kind, title, options, threadId = sideId) => post("question", { threadId, itemId, kind, questions: [{ id: itemId + "-field", question: title, title, options }] });
  await question("side-sync-a", "sync", "侧边同步问题一", [{ label: "先测试", description: "独立验证" }]);
  await question("side-sync-b", "sync", "侧边同步问题二", []);
  await expect(card(page, "侧边同步问题一")).toBeVisible();
  await expect(card(page, "侧边同步问题二")).toBeVisible();
  await post("start-main", { threadId: "main-a" });
  await question("main-sync", "sync", "主会话同步问题", [{ label: "主会话的回答", description: "保留主会话范围" }], "main-a");
  const mainCard = page.locator("#conversation-messages .toolQuestionCard").filter({ hasText: "主会话同步问题" });
  await expect(mainCard).toBeVisible();
  const draft = card(page, "侧边同步问题二").getByRole("textbox"); await draft.fill("第二个同步问题的草稿");
  const mainEditor = page.locator('.composer:not(.temporaryAskComposer) [contenteditable="true"]').first();
  await mainEditor.fill("保留主会话草稿");
  await post("fail-next-question");
  await card(page, "侧边同步问题一").getByRole("button", { name: /先测试/ }).click();
  await expect(page.locator(".errorBanner")).toContainText("模拟问题回答失败，请重试");
  await expect(card(page, "侧边同步问题一").getByRole("button", { name: /先测试/ })).toBeEnabled();
  await expect(draft).toHaveValue("第二个同步问题的草稿");
  await card(page, "侧边同步问题一").getByRole("button", { name: /先测试/ }).click();
  await expect(card(page, "侧边同步问题一")).toHaveCount(0);
  await expect(draft).toHaveValue("第二个同步问题的草稿");
  await expect(mainEditor).toHaveText("保留主会话草稿"); await expect(mainCard).toBeVisible();
  assert.deepEqual((await state()).questionResponses.map(value => [value.threadId, value.itemId]), [[sideId, "side-sync-a"]]);
  await page.reload({ waitUntil: "domcontentloaded" }); await openMain("main-a");
  await expect(card(page, "侧边同步问题一")).toHaveCount(0);
  await expect(card(page, "侧边同步问题二")).toBeVisible();
  await expect(panel(page).getByRole("article", { name: "已提交的问答" })).toContainText("先测试");
  await card(page, "侧边同步问题二").getByRole("textbox").fill("第二个同步问题的回答");
  await card(page, "侧边同步问题二").getByRole("button", { name: "发送自定义答案", exact: true }).click();
  await expect(card(page, "侧边同步问题二")).toHaveCount(0); await expect(mainCard).toBeVisible();
  assert.equal((await state()).questionResponses.length, 2);

  await question("side-async-a", "async", "侧边异步问题一", ["方案甲", "方案乙"]);
  await question("side-async-b", "async", "侧边异步问题二", []);
  await expect(card(page, "侧边异步问题一")).toBeVisible(); await expect(card(page, "侧边异步问题二")).toBeVisible();
  await post("complete", { threadId: sideId });
  await expect(card(page, "侧边异步问题一")).toBeVisible(); await expect(card(page, "侧边异步问题二")).toBeVisible();
  await openMain("main-b"); await expect(panel(page)).toHaveCount(0); await openMain("main-a");
  await expect(card(page, "侧边异步问题一")).toBeVisible(); await expect(card(page, "侧边异步问题二")).toBeVisible();
  const asyncDraft = card(page, "侧边异步问题二").getByRole("textbox"); await asyncDraft.fill("异步问题二的草稿");
  await post("fail-next-question");
  await card(page, "侧边异步问题一").getByRole("button", { name: /方案甲/ }).click();
  await expect(page.locator(".errorBanner")).toContainText("模拟问题回答失败，请重试");
  await expect(card(page, "侧边异步问题一").getByRole("button", { name: /方案甲/ })).toBeEnabled();
  await card(page, "侧边异步问题一").getByRole("button", { name: /方案甲/ }).click();
  await expect(card(page, "侧边异步问题一")).toHaveCount(0); await expect(asyncDraft).toHaveValue("异步问题二的草稿");
  await expect(mainCard).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" }); await openMain("main-a");
  await expect(card(page, "侧边异步问题一")).toHaveCount(0); await expect(card(page, "侧边异步问题二")).toBeVisible();
  await card(page, "侧边异步问题二").getByRole("textbox").fill("异步问题二的回答");
  await card(page, "侧边异步问题二").getByRole("button", { name: "发送自定义答案", exact: true }).click();
  await expect(card(page, "侧边异步问题二")).toHaveCount(0);
  assert.deepEqual((await state()).questionOutputs.map(value => [value.threadId, value.output.itemId]), [[sideId, "side-async-a"], [sideId, "side-async-b"]]);
  await question("side-function", "function", "兼容格式异步问题", ["兼容答案"]);
  await expect(card(page, "兼容格式异步问题")).toBeVisible();
  await card(page, "兼容格式异步问题").getByRole("button", { name: /兼容答案/ }).click();
  await expect(card(page, "兼容格式异步问题")).toHaveCount(0);
  await question("side-nonblocking", "nonblocking", "原生非阻塞问题", []);
  await expect(card(page, "原生非阻塞问题")).toBeVisible();
  await setContentViewport(page, { width: 393, height: 780 });
  await card(page, "原生非阻塞问题").getByRole("textbox").fill("手机端回答");
  await card(page, "原生非阻塞问题").getByRole("button", { name: "发送自定义答案", exact: true }).click();
  await expect(card(page, "原生非阻塞问题")).toHaveCount(0);
  await page.screenshot({ path: evidence + "/mobile-answered.png" });
  await setContentViewport(page, { width: 1600, height: 1000 });
  await mainCard.getByRole("button", { name: /主会话的回答/ }).click(); await expect(mainCard).toHaveCount(0);
  const final = await state();
  assert.equal(final.questionResponses.filter(value => value.threadId === sideId).length, 3);
  assert.equal(final.questionResponses.filter(value => value.threadId === "main-a").length, 1);
  assert.equal(final.pendingApprovals.length, 0);
  assert.ok(sent.filter(message => message.type === "question.respond").every(message => message.threadId === sideId));
  assert.equal(sent.filter(message => ["thread.start", "turn.start", "turn.steer", "turn.queue.add"].includes(message.type)).length, 1, "only the original side question starts a user prompt");
  assert.equal(await panel(page).getByText("正在生成问题…", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  const result = { isolatedDatabase: true, realRestAndWebsocket: true, mockModelOnly: true, synchronousSideInputs: true,
    nativeTypedAsyncSideInputs: true, legacyAsyncSideInputs: true, nativeNonblockingSideInput: true,
    answersReachSideThread: true, mainQuestionUnaffected: true, failedAnswersRetryable: true, secondQuestionDraftPreserved: true,
    pendingSyncRestoredOnReload: true, completedAsyncRestoredOnReload: true, answersPersisted: true,
    switchMainRestoresQuestions: true, mobileAnswerSubmitted: true, noAnswersSentAsNewMessages: true, pageErrors: errors };
  await fs.writeFile(evidence + "/result.json", JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result));
} catch (error) {
  await fs.writeFile(evidence + "/failure-state.json", JSON.stringify({ state: await readState?.(), sent }, null, 2)).catch(() => {});
  for (const page of browser?.contexts().flatMap(context => context.pages()) ?? []) await page.screenshot({ path: evidence + "/failure.png" }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); clearTimeout(timer);
  }
}
