import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "@playwright/test";

const children = [];
let browser;
const start = (args, env = {}) => {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); child.stderr.on("data", chunk => process.stderr.write(chunk)); return child;
};
const ready = (child, pattern) => new Promise((resolve, reject) => {
  let output = "";
  const timeout = setTimeout(() => reject(new Error("test service startup timeout: " + output.slice(-1000))), 15000);
  child.stdout.on("data", chunk => {
    output += chunk;
    const match = pattern(output);
    if (match) { clearTimeout(timeout); resolve(match); }
  });
  child.once("exit", code => { clearTimeout(timeout); reject(new Error("test service exited: " + code + " " + output.slice(-1000))); });
});
const quoteA = "第一段正文用于主会话 A 的侧边提问。";
const quoteB = "第二段正文用于主会话 B 的侧边提问。";
const panel = page => page.getByRole("complementary", { name: "临时侧边对话" });
const composer = page => panel(page).locator('[contenteditable="true"]');

async function checkPolicyMenu(page, trigger) {
  await trigger.click();
  const id = await trigger.getAttribute("aria-controls");
  assert.ok(id, "the access control identifies its menu");
  const menu = page.locator(`[id=${JSON.stringify(id)}]`);
  await menu.waitFor();
  await menu.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
  const bounds = await menu.boundingBox(), viewport = page.viewportSize();
  assert.ok(bounds.x >= 7 && bounds.y >= 7 && bounds.x + bounds.width <= viewport.width - 7 && bounds.y + bounds.height <= viewport.height - 7,
    "access menus must fit the viewport: " + JSON.stringify({ bounds, viewport }));
  assert.ok(await menu.evaluate(element => {
    const first = element.querySelector('[role="option"]'), box = first.getBoundingClientRect();
    return first.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), "access menu options remain above the side panel and other overlays");
  await trigger.press("Escape");
  await menu.waitFor({ state: "detached" });
}

async function selectQuote(page, text) {
  await page.locator("#conversation-messages").getByText(text, { exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "在侧边提问", exact: true }).click();
}
async function switchMain(page, id, text) {
  await page.locator(`[data-thread-id="${id}"] .threadSelectButton`).click();
  await page.locator("#conversation-messages").getByText(text, { exact: true }).waitFor();
}

const settleLayout = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

try {
  const backend = start(["--import", "tsx/esm", "tests/boundSideChats.server.ts"]);
  const metadata = await ready(backend, output => {
    for (const line of output.split("\n")) { try { const item = JSON.parse(line); if (item.ready) return item; } catch {} }
  });
  const frontend = start(["--max-old-space-size=768", "node_modules/vite/bin/vite.js", "--config", "tests/boundSideChats.vite.config.mjs"], { BOUND_SIDE_CHAT_TEST_BACKEND: metadata.origin });
  await ready(frontend, output => output.includes("http://127.0.0.1:5212/") && true);
  const origin = "http://127.0.0.1:5212", errors = [];
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.request.post(origin + "/api/auth/login");
  await context.addInitScript(projectId => {
    localStorage.setItem("codex-web-user-id", "admin");
    localStorage.setItem("codex-v2-project-admin", projectId);
    localStorage.setItem("codex-v2-expanded-projects-admin", JSON.stringify([projectId]));
  }, metadata.projectId);
  const openPage = async (id, quote) => {
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/?project=${metadata.projectId}&thread=${id}`, { waitUntil: "domcontentloaded" });
    await page.locator("#conversation-messages").getByText(quote, { exact: true }).waitFor(); return page;
  };
  const state = async () => (await context.request.get(origin + "/api/__test/state")).json();
  const complete = async id => context.request.post(origin + "/api/__test/complete", { data: { threadId: id } });
  const first = await openPage("main-a", quoteA);
  assert.equal(await panel(first).count(), 0);
  await selectQuote(first, quoteA);
  await checkPolicyMenu(first, first.locator('.topbarPolicySelect:not(.approvalSelect) .polishedSelectTrigger'));
  const sideAccess = panel(first).locator('.polishedSelectTrigger').filter({ hasText: /完全访问|项目可写|只读/ });
  await checkPolicyMenu(first, sideAccess);
  await first.setViewportSize({ width: 1100, height: 500 });
  await checkPolicyMenu(first, sideAccess);
  await first.setViewportSize({ width: 393, height: 780 });
  await checkPolicyMenu(first, sideAccess);
  await first.setViewportSize({ width: 1600, height: 1000 });
  const mainInput = first.locator('.composer:not(.temporaryAskComposer) [contenteditable="true"]').first();
  const glow = first.locator('.composerAmbientGlow');
  await mainInput.focus();
  assert.equal(await glow.getAttribute("data-active"), "false", "empty editor focus alone must not keep the glow lit");
  await mainInput.fill("真实页面中的草稿光效");
  await first.waitForFunction(() => document.querySelector('.composerAmbientGlow')?.dataset.active === "true");
  await mainInput.fill("");
  await first.waitForFunction(() => document.querySelector('.composerAmbientGlow')?.dataset.active === "false");
  assert.ok(await mainInput.evaluate(element => document.activeElement === element), "clearing the main editor keeps focus while the glow fades");
  await mainInput.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await first.waitForFunction(() => document.querySelector('.composerAmbientGlow')?.dataset.active === "true");
  await checkPolicyMenu(first, sideAccess);
  assert.equal(await glow.getAttribute("data-active"), "true", "a delayed preedit keeps the glow through unrelated parent renders");
  await mainInput.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" })));
  await composer(first).fill("A 的草稿");
  await first.waitForFunction(() => document.querySelector('.composerAmbientGlow')?.dataset.active === "true");
  await composer(first).fill("");
  await first.waitForFunction(() => document.querySelector('.composerAmbientGlow')?.dataset.active === "false");
  assert.ok(await composer(first).evaluate(element => document.activeElement === element), "clearing the side editor also fades the glow without losing focus");
  await composer(first).fill("A 的草稿");
  const draftSaved = first.waitForResponse(response => response.url().includes("/side-chat") && response.request().method() === "PATCH");
  await switchMain(first, "main-c", "这个主会话还没有侧边会话。");
  await (await draftSaved).finished();
  assert.equal(await panel(first).count(), 0, "a main thread without a side chat hides the panel");
  const draftPage = await openPage("main-a", quoteA);
  assert.equal(await composer(draftPage).innerText(), "A 的草稿", "an unsent draft is restored from the database in a new tab");
  assert.equal((await state()).calls.filter(call => call.method === "thread/fork").length, 0, "opening a side chat alone never starts a model");
  await draftPage.close();
  await switchMain(first, "main-a", quoteA);
  assert.equal(await composer(first).innerText(), "A 的草稿");
  await composer(first).press("Enter");
  await panel(first).getByText("侧边回答 1：A 的草稿", { exact: true }).waitFor();
  let snapshot = await state();
  const a = snapshot.sides.find(side => side?.parentThreadId === "main-a");
  assert.ok(a.threadId);
  assert.ok(snapshot.calls.some(call => call.method === "thread/fork" && call.threadId === "main-a"));
  assert.equal(snapshot.calls.some(call => call.method === "thread/start"), false);
  assert.equal(snapshot.calls.filter(call => call.method === "thread/fork").length, 1);

  const append = (threadId, delta) => context.request.post(origin + "/api/__test/append", { data: { threadId, delta } });
  const sideScroller = panel(first).locator(".temporaryAskMessages");
  await append(a.threadId, "\n\n" + Array.from({ length: 65 }, (_, i) => `侧边长回答第 ${i + 1} 段，用于上翻阅读时保持滚动位置。`).join("\n\n"));
  await panel(first).getByText("侧边长回答第 65 段，用于上翻阅读时保持滚动位置。", { exact: true }).waitFor();
  await first.waitForFunction(() => { const e = document.querySelector('.temporaryAskMessages'); return e.scrollHeight - e.clientHeight > 1000; });
  await sideScroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await settleLayout(first);
  await sideScroller.evaluate(element => { element.scrollTop = 250; });
  await settleLayout(first);
  const readingTop = await sideScroller.evaluate(element => element.scrollTop);
  const assertReadingPosition = async label => {
    await settleLayout(first);
    assert.ok(Math.abs(await sideScroller.evaluate(element => element.scrollTop) - readingTop) < 3, label);
  };
  await context.request.post(origin + "/api/__test/start-main", { data: { threadId: "main-a" } });
  await append("main-a", "\n\n主会话滚动测试片段一");
  await first.locator("#conversation-messages").getByText("主会话滚动测试片段一", { exact: false }).first().waitFor();
  await assertReadingPosition("main-thread streaming must not scroll a side chat being read");
  await context.request.post(origin + "/api/__test/main-tool", { data: { threadId: "main-a" } });
  await append("main-a", "\n\n主会话滚动测试片段二");
  await first.locator("#conversation-messages").getByText("主会话滚动测试片段二", { exact: false }).first().waitFor();
  await assertReadingPosition("main-thread tool updates must not move the side chat");
  await append(a.threadId, "\n\n侧边继续生成时也要保留上翻位置");
  await panel(first).getByText("侧边继续生成时也要保留上翻位置", { exact: true }).waitFor();
  await assertReadingPosition("side-thread streaming must respect a reader who scrolled up");
  await sideScroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await settleLayout(first);
  await append(a.threadId, "\n\n" + Array.from({ length: 12 }, (_, i) => `回到底部后自动跟随第 ${i + 1} 段`).join("\n\n"));
  await panel(first).getByText("回到底部后自动跟随第 12 段", { exact: true }).waitFor();
  await first.waitForFunction(() => { const e = document.querySelector('.temporaryAskMessages'); return e.scrollHeight - e.clientHeight - e.scrollTop < 3; });
  await complete("main-a");

  const second = await openPage("main-a", quoteA);
  await panel(second).getByText("侧边回答 1：A 的草稿", { exact: true }).waitFor();
  await panel(second).getByText(quoteA, { exact: true }).last().waitFor();
  assert.equal((await state()).calls.filter(call => call.method === "thread/fork").length, 1, "restoring a new tab never creates another native thread");
  await context.request.post(origin + "/api/__test/append", { data: { threadId: a.threadId, delta: "\n\n恢复后仍能实时更新" } });
  await panel(second).getByText("恢复后仍能实时更新", { exact: true }).waitFor();
  await switchMain(first, "main-b", quoteB);
  assert.equal(await panel(first).count(), 0);
  await selectQuote(first, quoteB);
  await composer(first).fill("B 的独立问题"); await composer(first).press("Enter");
  await panel(first).getByText("侧边回答 1：B 的独立问题", { exact: true }).waitFor();
  snapshot = await state();
  const b = snapshot.sides.find(side => side?.parentThreadId === "main-b");
  assert.notEqual(a.threadId, b.threadId);
  await complete(a.threadId);
  await panel(first).getByText("侧边回答 1：B 的独立问题", { exact: true }).waitFor();
  await switchMain(first, "main-a", quoteA);
  await panel(first).getByText("侧边回答 1：A 的草稿", { exact: true }).waitFor();
  assert.equal(await panel(first).getByText("B 的独立问题", { exact: true }).count(), 0);
  await composer(first).fill("A 的第二个问题");
  await selectQuote(first, quoteA);
  assert.equal(await composer(first).innerText(), "A 的第二个问题", "reopening preserves the current draft");
  await composer(first).press("Enter");
  await panel(first).getByText("侧边回答 2：A 的第二个问题", { exact: true }).waitFor();
  await panel(second).getByText("侧边回答 2：A 的第二个问题", { exact: true }).waitFor();
  assert.equal((await state()).calls.filter(call => call.method === "thread/fork").length, 2);
  await second.reload();
  await switchMain(second, "main-a", quoteA);
  await panel(second).getByText("侧边回答 2：A 的第二个问题", { exact: true }).waitFor();
  await switchMain(first, "main-b", quoteB);
  await panel(first).getByText("侧边回答 1：B 的独立问题", { exact: true }).waitFor();
  await panel(first).getByRole("button", { name: "关闭并删除临时对话", exact: true }).click();
  await first.getByRole("dialog", { name: "关闭侧边聊天?" }).getByRole("button", { name: "关闭侧边聊天", exact: true }).click();
  await panel(first).waitFor({ state: "detached" });
  snapshot = await state();
  assert.equal(snapshot.sides.find(side => side?.parentThreadId === "main-b"), undefined);
  assert.ok(snapshot.sides.find(side => side?.parentThreadId === "main-a"));
  assert.equal(snapshot.calls.filter(call => call.method === "turn/interrupt").every(call => call.threadId === b.threadId), true);
  assert.equal(snapshot.calls.filter(call => call.method === "turn/interrupt").length > 0, true);
  await switchMain(second, "main-b", quoteB);
  assert.equal(await panel(second).count(), 0, "closed side chats do not return in another tab");
  await selectQuote(first, quoteB);
  await context.request.post(origin + "/api/__test/hold-create", { data: { pause: true } });
  await composer(first).fill("B 的延迟问题"); await composer(first).press("Enter");
  await panel(first).locator(".temporaryAskHeaderState").filter({ hasText: "启动中" }).waitFor({ state: "attached" });
  await switchMain(first, "main-c", "这个主会话还没有侧边会话。");
  await context.request.post(origin + "/api/__test/hold-create", { data: { pause: false } });
  await panel(second).getByText("侧边回答 1：B 的延迟问题", { exact: true }).waitFor();
  assert.equal(await panel(first).count(), 0, "a late acknowledgement never opens the wrong main thread's panel");
  await switchMain(first, "main-b", quoteB);
  await panel(first).getByText("侧边回答 1：B 的延迟问题", { exact: true }).waitFor();
  assert.equal((await state()).calls.filter(call => call.method === "thread/fork").length, 3);
  await switchMain(first, "main-a", quoteA);
  await panel(first).getByText("侧边回答 2：A 的第二个问题", { exact: true }).waitFor();
  await complete(a.threadId);
  await context.request.post(origin + "/api/__test/fail-next");
  await composer(first).fill("产生可复制的错误"); await composer(first).press("Enter");
  const banner = first.locator(".errorBanner").filter({ hasText: "用于选中复制的完整错误详情" });
  const errorText = banner.locator(".errorBannerMessage");
  await errorText.click();
  const fullError = await errorText.innerText();
  await errorText.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  assert.equal(await first.evaluate(() => getSelection().toString()), fullError);
  assert.equal(await errorText.innerText(), fullError);
  await banner.getByRole("button", { name: "关闭错误提示", exact: true }).click();
  await banner.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: "chromium", isolatedDatabase: true, realRestAndWebsocket: true, mockModelOnly: true,
    nativeForkInheritsContext: true, inheritedHistoryRestored: true, boundToParent: true, draftRestored: true, missingSideHidden: true, switchesBetweenSideChats: true,
    newTabRestoresRunningSideChat: true, restoredSideKeepsStreaming: true, reloadRestoresSideChat: true, followupReusesThread: true,
    lateAcknowledgementStaysWithParent: true, backgroundCompletionDoesNotSwitchPanel: true,
    closeOnlyInterruptsMatchingSide: true, deletedSideDoesNotReturn: true, errorCanBeSelectedAndDismissed: true,
    mainStreamDoesNotScrollSide: true, mainToolsDoNotScrollSide: true, sideStreamPreservesReadingPosition: true, sideFollowingResumesAtBottom: true,
    accessMenusFitViewport: true, draftAndPreeditKeepGlow: true, clearDraftFadesWithFocus: true, pageErrors: errors }));
} catch (error) {
  for (const page of browser?.contexts().flatMap(context => context.pages()) ?? []) {
    console.error(JSON.stringify({ url: page.url(), diagnostics: await page.evaluate(() => ({
      focused: document.hasFocus(), activeElement: document.activeElement?.outerHTML.slice(0, 400),
      glow: document.querySelector('.composerAmbientGlow')?.outerHTML.slice(0, 400)
    })).catch(() => null) }));
    await page.screenshot({ path: "/tmp/lzc-bound-side-chat-failure.png" }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
