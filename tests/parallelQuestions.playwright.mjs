import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const origin = process.env.QUESTION_TEST_ORIGIN ?? "http://127.0.0.1:5212";
const project = { id: "questions-project", name: "问题验收", rootPath: "/test", userId: "lzc", defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "high", defaultSandbox: "read-only", defaultApprovalPolicy: "never" };
const questions = [
  { id: "question-a", title: "第一个问题", options: ["先测试", "稍后测试"] },
  { id: "question-b", title: "第二个问题", options: [] }
];
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const native of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(({ questions, native }) => {
      localStorage.setItem("codex-web-user-id", "lzc");
      const answered = () => JSON.parse(localStorage.getItem("fixture-answered") ?? "[]");
      class FixtureSocket extends EventTarget {
        static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
        readyState = 0;
        constructor() {
          super(); window.questionWrites = []; window.questionSocket = this;
          window.failQuestionAnswer = answered().length === 0;
          setTimeout(() => {
            this.readyState = 1; this.dispatchEvent(new Event("open"));
            this.emit({ type: "hello", data: { liveState: this.snapshot(), pendingServerRequests: native ? questions.filter(q => !answered().includes(q.id)).map(q => ({
              id: "rpc-" + q.id, method: "item/tool/requestUserInput", params: { threadId: "questions-thread", turnId: "questions-turn", itemId: q.id, isBlocking: false,
                questions: [{ id: q.id, question: q.title, options: q.options.map(label => ({ label, description: label })) }] }
            })) : [] } });
          }, 40);
        }
        snapshot() { return { activeTurns: [], agentMessages: [], toolItems: [] }; }
        emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
        send(raw) {
          const message = JSON.parse(raw);
          if (message.type === "transport.ping") return this.emit({ type: "transport.pong" });
          if (message.type === "live.state") return this.emit({ type: "live.state", data: this.snapshot() });
          if (message.type === "turn.queue.list") return this.emit({ type: "ack", requestId: message.requestId, ok: true, data: { data: [] } });
          window.questionWrites.push(message);
          if (!["question.respond", "userInput.respond"].includes(message.type)) return;
          setTimeout(() => {
            if (window.failQuestionAnswer) {
              window.failQuestionAnswer = false;
              this.emit({ type: "ack", requestId: message.requestId, ok: false, error: "模拟提交失败" }); return;
            }
            const itemId = native ? message.codexRequestId.slice(4) : message.itemId;
            localStorage.setItem("fixture-answered", JSON.stringify([...answered(), itemId]));
            if (native) {
              this.emit({ type: "codex.notification", data: { method: "serverRequest/resolved", params: { threadId: "questions-thread", requestId: message.codexRequestId } } });
              this.emit({ type: "codex.notification", data: { method: "turn/completed", params: { threadId: "questions-thread", turn: { id: "questions-turn", status: "completed" } } } });
            } else this.emit({ type: "question.answered", data: { threadId: "questions-thread", itemId } });
            this.emit({ type: "live.tool", data: { itemId: "receipt-" + itemId, threadId: "questions-thread", turnId: "questions-turn", tool: "request_user_input_async", input: "", output: JSON.stringify({ type: "codex_web_question_answer", itemId }), completed: true, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
            this.emit({ type: "ack", requestId: message.requestId, ok: true });
          }, 120);
        }
        close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
      }
      window.WebSocket = FixtureSocket;
    }, { questions, native });
    await page.route("**/api/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      const answered = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture-answered") ?? "[]"));
      const thread = { id: "questions-thread", name: "并行问题验收", sessionId: "questions-thread", cwd: "/test", updatedAt: 1, createdAt: 1, status: "idle", answeredQuestionItemIds: answered, turns: [
        { id: "questions-turn", status: "completed", items: questions.map(q => ({ id: q.id, type: "toolCall", tool: "request_user_input_async", input: JSON.stringify({ questions: [{ id: q.id, title: q.title, options: q.options }] }), output: '{"accepted":true}', completed: true })) },
        { id: "unrelated-turn", status: "completed", items: [{ id: "unrelated-user", type: "userMessage", text: "补充一条和上述问题无关的信息" }, ...answered.map(itemId => ({ id: "receipt-" + itemId, type: "toolCall", tool: "request_user_input_async", input: "", output: JSON.stringify({ type: "codex_web_question_answer", itemId }), completed: true }))] }
      ] };
      let json = { data: [] };
      if (pathname === "/api/projects") json = { data: [project], projectRoot: "/test" };
      else if (pathname === "/api/users") json = { data: [{ id: "lzc", name: "lzc" }], defaultUserId: "lzc" };
      else if (pathname === "/api/pets") json = { pets: [], activePetId: null, visible: false, position: null };
      else if (pathname === "/api/threads/questions-thread") json = { thread, history: { totalItems: 3, returnedItems: 3, before: 0, hasOlder: false } };
      else if (pathname === "/api/projects/questions-project/threads") json = { data: [thread] };
      else if (pathname.endsWith("/execution-settings")) json = { data: { sandbox: "read-only", approvalPolicy: "never" } };
      else if (pathname.endsWith("/context")) json = { data: null };
      else if (pathname.endsWith("/subagents")) json = { data: [], page: { total: 0, activeCount: 0, historyCount: 0, hasMore: false } };
      else if (pathname === "/api/codex/account-pool") json = { data: { strategy: "single-account", accounts: [] } };
      else if (pathname === "/api/models") json = { data: [{ id: "sol", label: "Sol", model: "gpt-6.1-sol", effort: "high" }] };
      await route.fulfill({ json });
    });
    await page.goto(origin + "/?project=questions-project&thread=questions-thread");
    await page.waitForFunction(() => document.querySelectorAll(".toolQuestionCard").length === 2);
    const second = page.getByRole("textbox", { name: "自行输入答案：第二个问题" });
    await second.fill("第二题尚未提交的草稿");
    await page.getByRole("button", { name: /先测试/ }).click();
    await page.getByText(/回答发送失败：模拟提交失败/).waitFor();
    assert.equal(await page.locator(".toolQuestionCard").count(), 2);
    assert.equal(await second.inputValue(), "第二题尚未提交的草稿");
    await page.getByRole("button", { name: /先测试/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".toolQuestionCard").length === 1);
    assert.equal(await page.getByText("正在生成问题…", { exact: true }).count(), 0, "a live answer receipt is not a new question");
    assert.equal(await second.inputValue(), "第二题尚未提交的草稿");
    const firstWrites = await page.evaluate(() => window.questionWrites);
    const replies = firstWrites.filter(m => m.type === (native ? "userInput.respond" : "question.respond"));
    assert.equal(replies.length, 2);
    assert.equal(native ? replies[1].codexRequestId : replies[1].itemId, native ? "rpc-question-a" : "question-a");
    assert.equal(firstWrites.some(m => ["turn.start", "turn.steer", "turn.queue.add", "thread.start"].includes(m.type)), false);
    await page.reload();
    await page.locator('[data-thread-id="questions-thread"] .threadSelectButton').click();
    await page.waitForFunction(() => document.querySelectorAll(".toolQuestionCard").length === 1);
    assert.equal(await page.getByText("正在生成问题…", { exact: true }).count(), 0, "persisted answer receipts never show a generating placeholder");
    await second.fill("第二题的独立回答");
    await page.getByRole("button", { name: "发送自定义答案" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".toolQuestionCard").length === 0);
    await page.reload();
    await page.locator('[data-thread-id="questions-thread"] .threadSelectButton').click();
    assert.equal(await page.locator(".toolQuestionCard").count(), 0);
    assert.equal(await page.getByText("正在生成问题…", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    results.push({ native, independentQuestions: true, failedAnswerPreserved: true, otherDraftPreserved: true, survivesTurnCompletion: true, persistsAfterReload: true, appendedUserMessages: 0 });
    await page.close();
  }
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
