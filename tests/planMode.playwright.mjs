import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const origin = process.env.QUESTION_TEST_ORIGIN ?? "http://127.0.0.1:5193";
const project = { id: "mode-project", name: "模式验收", rootPath: "/test", userId: "lzc", defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "max", defaultSandbox: "danger-full-access", defaultApprovalPolicy: "never" };
const thread = (id, name, mode) => ({ id, sessionId: id, name, cwd: "/test", collaborationMode: mode, updatedAt: 1, createdAt: 1, status: "completed", turns: [{ id: `${id}-turn`, status: "completed", items: [{ id: `${id}-user`, type: "userMessage", text: "先给出方案" }, { id: `${id}-agent`, type: "agentMessage", text: "方案已经完成" }] }] });
const threads = [thread("mode-thread", "刷新后的计划会话", "plan"), thread("other-thread", "另一个会话", "default")];
const browser = await chromium.launch({ headless: true });
const errors = [];
let page;
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("codex-web-user-id", "lzc");
    localStorage.setItem("codex-v2-project-lzc", "mode-project");
    localStorage.setItem("codex-v2-expanded-projects-lzc", JSON.stringify(["mode-project"]));
    class FixtureSocket extends EventTarget {
      static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; readyState = 0;
      constructor() {
        super(); window.modeWrites = [];
        setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.emit({ type: "hello", data: { liveState: this.snapshot(), turnProgress: [], pendingServerRequests: [], turnRecoveries: [this.recovery()] } }); }, 40);
      }
      recovery() { return { threadId: "mode-thread", error: { code: "model_overloaded", message: "模型服务暂时过载，已完成的步骤会沿用。", originalMessage: "Selected model is at capacity. Please try a different model.", retryable: true, at: new Date().toISOString() }, job: { status: "waiting", attempts: 0, maxAttempts: 10, nextRetryAt: Date.now() + 60_000 } }; }
      snapshot() { return { activeTurns: [], agentMessages: [], toolItems: [] }; }
      emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
      send(raw) {
        const message = JSON.parse(raw);
        if (message.type === "transport.ping") return this.emit({ type: "transport.pong" });
        if (message.type === "live.state") return this.emit({ type: "live.state", data: this.snapshot() });
        if (message.type === "turn.queue.list") return this.emit({ type: "ack", requestId: message.requestId, ok: true, data: { data: [] } });
        window.modeWrites.push(message);
        if (message.type === "turn.retry.cancel" || message.type === "turn.error.dismiss") {
          const state = this.recovery(); state.job = null; if (message.type === "turn.error.dismiss") state.error = null;
          this.emit({ type: "turn.recovery", data: state });
        }
        setTimeout(() => this.emit({ type: "ack", requestId: message.requestId, ok: true, data: {} }), 40);
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    }
    window.WebSocket = FixtureSocket;
  });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let json = { data: [] };
    if (path === "/api/projects") json = { data: [project], projectRoot: "/test" };
    else if (path === "/api/users") json = { data: [{ id: "lzc", name: "lzc" }], defaultUserId: "lzc" };
    else if (path === "/api/pets") json = { pets: [], activePetId: null, visible: false, position: null };
    else if (path === "/api/projects/mode-project/threads") json = { data: threads };
    else if (threads.some(thread => path === `/api/threads/${thread.id}`)) json = { thread: threads.find(thread => path.endsWith(thread.id)), history: { totalItems: 2, returnedItems: 2, before: 0, hasOlder: false } };
    else if (path.endsWith("/execution-settings")) json = { data: { sandbox: "danger-full-access", approvalPolicy: "never" } };
    else if (path.endsWith("/context")) json = { data: null };
    else if (path.endsWith("/subagents")) json = { data: [], page: { total: 0, activeCount: 0, historyCount: 0, hasMore: false } };
    else if (path === "/api/codex/account-pool") json = { data: { strategy: "highest-remaining-sticky-thread", accounts: [] } };
    else if (path === "/api/models") json = { data: [{ id: "sol", label: "Sol", model: "gpt-6.1-sol", effort: "max" }] };
    await route.fulfill({ json });
  });
  await page.goto(`${origin}/?project=mode-project&thread=mode-thread`);
  await page.locator(".v2PlanActiveChip").waitFor();
  assert.equal(await page.locator(".appRenderFallback").count(), 0);
  await page.getByText(/等待重试 · \d+ 秒 · 第 1\/10 次/).waitFor();
  await page.reload();
  await page.locator('[data-thread-id="mode-thread"] .threadSelectButton').click();
  await page.getByText(/等待重试 · \d+ 秒 · 第 1\/10 次/).waitFor();
  await page.getByText("错误详情 · model_overloaded", { exact: true }).click();
  await page.getByText("Selected model is at capacity. Please try a different model.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消自动重试", exact: true }).click();
  await page.getByRole("button", { name: "关闭模型状态提示", exact: true }).click();
  await page.locator(".turnRecoveryNotice").waitFor({ state: "detached" });
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('[data-thread-id="other-thread"]').click({ button: "right" });
    const menu = page.getByRole("menu"); await menu.waitFor();
    const visible = await menu.evaluate(element => ({
      portal: element.parentElement === document.body,
      items: [...element.querySelectorAll('[role="menuitem"]')].map(item => {
        const rect = item.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { aboveList: Boolean(hit && item.contains(hit)), inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight };
      })
    }));
    assert.equal(visible.portal, true); assert.equal(visible.items.length, 4);
    assert.equal(visible.items.every(item => item.aboveList && item.inViewport), true, `${theme} context menu items are above the list and inside the window`);
    if (theme === "light") {
      await page.getByRole("menuitem", { name: "重命名会话", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "重命名会话", exact: true }); await dialog.waitFor();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
    } else await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
  }
  await page.locator(".v2PlanActiveChip").click();
  await page.locator('.composer [contenteditable="true"][aria-label="随心输入"]').waitFor();
  await page.reload();
  await page.locator('[data-thread-id="mode-thread"] .threadSelectButton').click();
  await page.locator('.composer [contenteditable="true"][aria-label="随心输入"]').waitFor();
  assert.equal(await page.locator(".v2PlanActiveChip").count(), 0, "the explicit Default choice survives reload despite a previous native Plan turn");
  await page.locator('[data-thread-id="other-thread"] .threadSelectButton').click();
  await page.locator(".v2ComposerPlus").click();
  await page.locator('[data-action="plan"]').click();
  await page.locator(".v2PlanActiveChip").waitFor();
  await page.locator('[data-thread-id="mode-thread"] .threadSelectButton').click();
  await page.locator('.composer [contenteditable="true"][aria-label="随心输入"]').waitFor();
  assert.equal(await page.locator(".v2PlanActiveChip").count(), 0, "Plan selection does not leak between conversations");
  await page.locator('[data-thread-id="other-thread"] .threadSelectButton').click();
  await page.locator(".v2PlanActiveChip").waitFor();
  await page.reload();
  await page.locator('[data-thread-id="other-thread"] .threadSelectButton').click();
  await page.locator(".v2PlanActiveChip").waitFor();
  await page.locator('[data-thread-id="mode-thread"] .threadSelectButton').click();
  const execute = page.locator('.composer [contenteditable="true"][aria-label="随心输入"]');
  await execute.fill("开始执行已批准的方案"); await execute.press("Enter");
  await page.waitForFunction(() => window.modeWrites.some(message => message.type === "turn.start"));
  const writes = await page.evaluate(() => window.modeWrites);
  const start = writes.find(message => message.type === "turn.start");
  assert.equal(start.threadId, "mode-thread"); assert.equal(start.collaborationMode, "default");
  assert.equal(writes.some(message => message.type === "thread.start"), false, "switching modes continues the original conversation");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ nativePlanRestored: true, disableSurvivesReload: true, enableSurvivesReload: true, conversationChoicesIsolated: true, sendsExplicitDefault: true, newConversationCreated: false, contextMenuAboveList: true, menuItemsVisibleInBothThemes: true, overloadDetailsVisible: true, retryRestoredOnReload: true, retryCancelledAndDismissed: true }));
} catch (error) {
  console.error(JSON.stringify({ errors, composer: await page?.locator(".composer").evaluate(element => ({ mode: element.dataset.planMode, fields: [...element.querySelectorAll("textarea, [contenteditable]")].map(field => ({ tag: field.tagName, placeholder: field.getAttribute("placeholder"), aria: field.getAttribute("aria-label"), class: field.className })), preferences: Object.entries(localStorage).filter(([key]) => key.startsWith("codex-web-plan-mode:")) })), body: (await page?.locator("body").innerText())?.slice(0, 2000) }));
  throw error;
} finally { await browser.close(); }
