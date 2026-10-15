import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const origin = process.env.QUESTION_TEST_ORIGIN ?? "http://127.0.0.1:5193";
const questions = [{ id: "robot", question: "选择机器人范围", options: [{ label: "通用 ROS 2", description: "配置驱动" }] }, { id: "camera", question: "选择相机范围", options: null }];
const item = { id: "call-q", type: "toolCall", tool: "request_user_input", input: JSON.stringify({ questions }), completed: false };
const thread = { id: "fixture-thread", sessionId: "fixture-thread", name: "延迟回答验收", cwd: "/test", updatedAt: 1, createdAt: 1, status: "running", turns: [{ id: "fixture-turn", status: "running", items: [{ id: "user-1", type: "userMessage", text: "整理服务，先确认范围" }, item] }] };
const project = { id: "fixture-project", name: "验收项目", rootPath: "/test", userId: "lzc", defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "high", defaultSandbox: "danger-full-access", defaultApprovalPolicy: "never" };
const browser = await chromium.launch({ headless: true });
const results = [];
let page;
const errors = [], paths = [];
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(({ questions }) => {
    localStorage.setItem("codex-web-user-id", "lzc");
    class FixtureSocket extends EventTarget {
      static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
      readyState = 0;
      constructor() {
        super(); window.questionSocket = this; window.questionWrites = []; window.failQuestionAnswer = true;
        setTimeout(() => {
          this.readyState = 1; this.dispatchEvent(new Event("open"));
          this.emit({ type: "hello", data: { liveState: this.snapshot(), turnProgress: [], pendingServerRequests: [{ id: "pool-17", method: "item/tool/requestUserInput", params: { threadId: "fixture-thread", turnId: "fixture-turn", itemId: "call-q", isBlocking: true, questions } }] } });
        }, 40);
      }
      snapshot() { return { activeTurns: [{ threadId: "fixture-thread", turnId: "fixture-turn", status: "running" }], agentMessages: [], toolItems: [] }; }
      emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
      send(raw) {
        const message = JSON.parse(raw);
        if (message.type === "transport.ping") return this.emit({ type: "transport.pong" });
        if (message.type === "live.state") return this.emit({ type: "live.state", data: this.snapshot() });
        if (message.type === "turn.queue.list") return this.emit({ type: "ack", requestId: message.requestId, ok: true, data: { data: [] } });
        window.questionWrites.push(message);
        if (message.type === "userInput.respond") setTimeout(() => {
          if (window.failQuestionAnswer) { window.failQuestionAnswer = false; this.emit({ type: "ack", requestId: message.requestId, ok: false, error: "模拟发送失败" }); }
          else {
            this.emit({ type: "codex.notification", data: { method: "serverRequest/resolved", params: { threadId: "fixture-thread", requestId: "pool-17" } } });
            this.emit({ type: "turn.progress", data: { threadId: "fixture-thread", turnId: "fixture-turn", state: "active", silentForMs: 0 } });
            this.emit({ type: "ack", requestId: message.requestId, ok: true });
          }
        }, 120);
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    }
    window.WebSocket = FixtureSocket;
  }, { questions });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    paths.push(path);
    let json = { data: [] };
    if (path === "/api/projects") json = { data: [project], projectRoot: "/test" };
    else if (path === "/api/pets") json = { pets: [], activePetId: null, visible: false, position: null };
    else if (path === "/api/users") json = { data: [{ id: "lzc", name: "lzc" }], defaultUserId: "lzc" };
    else if (path === "/api/threads/fixture-thread") json = { thread, history: { totalItems: 2, returnedItems: 2, before: 0, hasOlder: false } };
    else if (path === "/api/projects/fixture-project/threads") json = { data: [thread] };
    else if (path.endsWith("/execution-settings")) json = { data: { sandbox: "danger-full-access", approvalPolicy: "never" } };
    else if (path.endsWith("/context")) json = { data: null };
    else if (path.endsWith("/subagents")) json = { data: [], page: { total: 0, activeCount: 0, historyCount: 0, hasMore: false } };
    else if (path === "/api/codex/account-pool") json = { data: { strategy: "highest-remaining-sticky-thread", accounts: [] } };
    else if (path === "/api/models") json = { data: [{ id: "sol", label: "Sol", model: "gpt-6.1-sol", effort: "high" }] };
    await route.fulfill({ json });
  });
  const url = `${origin}/?project=fixture-project&thread=fixture-thread`;
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector(".toolQuestionCard, .appRenderFallback"));
  assert.equal(await page.locator(".appRenderFallback").count(), 0, "fixture must initialize the application");
  await page.locator(".toolQuestionCard").waitFor();
  await page.getByText("正在等待你回答问题，回答后会继续。", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("延迟回答验收", { exact: true }).click();
  await page.locator(".toolQuestionCard").waitFor();
  assert.equal(await page.locator(".toolQuestionCard").count(), 1, "reconnect displays one question");
  await page.getByRole("button", { name: /通用 ROS 2/ }).click();
  const custom = page.getByRole("textbox", { name: "自行输入答案：选择相机范围" });
  await custom.fill("指定 RealSense D405");
  await page.getByRole("button", { name: "发送自定义答案" }).nth(1).click();
  await page.getByText(/回答发送失败：模拟发送失败/).waitFor();
  assert.equal(await page.locator(".toolQuestionCard").count(), 1);
  assert.equal(await custom.inputValue(), "指定 RealSense D405");
  await page.getByRole("button", { name: "发送自定义答案" }).nth(1).click();
  await page.locator(".toolQuestionCard").waitFor({ state: "detached" });
  const writes = await page.evaluate(() => window.questionWrites);
  const answers = writes.filter(message => message.type === "userInput.respond");
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[1].result, { answers: { robot: { answers: ["通用 ROS 2"] }, camera: { answers: ["指定 RealSense D405"] } } });
  assert.equal(answers[1].codexRequestId, "pool-17");
  assert.equal(writes.some(message => ["turn.steer", "turn.start", "turn.queue.add"].includes(message.type)), false);
  assert.deepEqual(errors, []);
  results.push({ fullApplication: true, lateQuestionRestored: true, failedReplyPreserved: true, nativeReplyConfirmed: true, appendedTurns: 0 });
  console.log(JSON.stringify(results));
} catch (error) {
  console.error(JSON.stringify({ errors, paths, body: (await page?.locator("body").innerText())?.slice(0, 6000) }));
  throw error;
} finally { await browser.close(); }
