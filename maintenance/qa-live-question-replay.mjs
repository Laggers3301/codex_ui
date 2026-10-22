// Replay real native notification shapes into the production frontend only.
// All answer/turn writes are intercepted before the socket; no model is invoked.
import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");
const root = new URL("../", import.meta.url);
const userId = process.env.QA_USER_ID, threadId = process.env.QA_THREAD_ID;
if (!userId || !threadId) throw new Error("Set QA_USER_ID and QA_THREAD_ID to an explicitly authorized read-only replay target");
const db = new DatabaseSync(new URL("data/backend/codex-web.sqlite", root).pathname, { readOnly: true });
const owned = db.prepare("SELECT project_id FROM thread_owners WHERE thread_id=? AND user_id=?").get(threadId, userId);
db.close();
if (!owned) throw new Error("Read-only replay target is not owned by the test user");
const prior = { projectId: owned.project_id, threadId };
const secret = (await fs.readFile(new URL("data/auth/session-secret", root), "utf8")).trim();
const payload = Buffer.from(JSON.stringify({ u: userId, exp: Date.now() + 600000 })).toString("base64url");
const cookie = payload + "." + createHmac("sha256", secret).update(payload).digest("base64url");
const base = "http://127.0.0.1:4574";
const output = new URL("data/backend/live-question-replay-20261021/", root);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const results = [], errors = [];
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 393, height: 850 } : { width: 1280, height: 850 } });
    await context.addCookies([{ name: "codex_remote_session_4575", value: cookie, url: base, httpOnly: true, sameSite: "Lax" }]);
    await context.addInitScript(({ projectId, userId }) => {
      localStorage.setItem("codex-web-user-id", userId);
      localStorage.setItem(`codex-v2-project-${userId}`, projectId);
      localStorage.setItem(`codex-v2-expanded-projects-${userId}`, JSON.stringify([projectId]));
      const Native = window.WebSocket;
      window.__questionReplay = { socket: null, writes: [] };
      window.WebSocket = class extends Native {
        constructor(...args) { super(...args); if (String(args[0]).includes("/ws")) window.__questionReplay.socket = this; }
        send(data) {
          let m; try { m = JSON.parse(String(data)); } catch { return super.send(data); }
          if (m.type === "turn.queue.list") return super.send(data);
          if (/^(turn\.|thread\.start|thread\.queue|userInput\.respond)/.test(m.type || "")) {
            window.__questionReplay.writes.push({ type: m.type, requestId: m.requestId });
            setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "ack", requestId: m.requestId, ok: true, data: {} }) })), 50);
            return;
          }
          return super.send(data);
        }
      };
    }, { projectId: prior.projectId, userId });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/?project=${prior.projectId}&thread=${prior.threadId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector(`.threadRow[data-thread-id="${prior.threadId}"]`, { state: "attached", timeout: 20000 });
    await page.waitForFunction(() => window.__questionReplay.socket?.readyState === 1);
    await page.waitForTimeout(1200);
    if (mobile) await page.evaluate(() => document.documentElement.dataset.theme = "light");
    for (const choices of [false, true]) {
      const id = `qa-replay-${mobile}-${choices}`, turnId = `qa-turn-${mobile}-${choices}`;
      const title = choices ? "【实时回放】选择处理方式" : "【实时回放】请输入验收路径";
      const questions = [{ title, options: choices ? ["先测试", "稍后处理"] : null }];
      const elapsed = await page.evaluate(async ({ threadId, turnId, id, questions }) => {
        const socket = window.__questionReplay.socket;
        const emit = message => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
        const start = performance.now();
        const seen = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("real-time question did not appear")); }, 2500);
          const observer = new MutationObserver(() => {
            if ([...document.querySelectorAll(".toolQuestionCard")].some(element => element.textContent.includes(questions[0].title))) {
              clearTimeout(timeout); observer.disconnect(); resolve(performance.now() - start);
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        });
        emit({ type: "codex.notification", data: { method: "turn/started", params: { threadId, turn: { id: turnId } } } });
        emit({ type: "codex.notification", data: { method: "item/started", params: { threadId, turnId, item: { type: "agentMessage", id, delivery: "async", phase: "final_answer", text: questions[0].title, questions } } } });
        // The old backend's lossy projection must not overwrite/duplicate the card.
        emit({ type: "live.agent", data: { itemId: id, sourceItemId: id, threadId, turnId, text: JSON.stringify({ questions }), completed: false, sequence: 999, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
        return seen;
      }, { threadId: prior.threadId, turnId, id, questions });
      assert.ok(elapsed < 2500);
      await page.evaluate(({ threadId, turnId, id, questions }) => {
        const emit = message => window.__questionReplay.socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
        emit({ type: "codex.notification", data: { method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id, delivery: "async", questions, text: questions[0].title } } } });
        emit({ type: "live.state", data: {
          agentMessages: [{ itemId: id, sourceItemId: id, threadId, turnId, text: JSON.stringify({ questions }), completed: true, sequence: 999, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
          toolItems: [], activeTurns: [{ threadId, turnId, status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
        } });
      }, { threadId: prior.threadId, turnId, id, questions });
      const card = page.locator(".toolQuestionCard").filter({ hasText: title });
      assert.equal(await card.count(), 1);
      const leaked = await page.locator(".messageItem.kind-agent").allTextContents();
      assert.ok(!leaked.some(text => text.includes('"questions"') && text.includes(title)));
      await page.screenshot({ path: new URL(`${mobile ? "mobile-light" : "desktop-dark"}-${choices ? "choices" : "free"}.png`, output).pathname });
      if (choices) await card.getByRole("button", { name: "先测试", exact: false }).click();
      else { await card.getByRole("textbox").fill("/qa/acceptance.py"); await card.getByRole("button", { name: "发送自定义答案" }).click(); }
      await card.waitFor({ state: "detached", timeout: 5000 });
      results.push({ mobile, choices, eventToCardMs: Math.round(elapsed), removedAfterSimulatedAck: true });
      console.log(JSON.stringify(results.at(-1)));
    }
    const writes = await page.evaluate(() => window.__questionReplay.writes);
    assert.equal(writes.length, 2, "exactly two answers, all blocked before network send");
    await context.close();
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(new URL("results.json", output), JSON.stringify({ results, errors, realNativeShapeReplayed: true, actualModelInvoked: false, answerAcksSimulated: true, physicalIphoneTested: false }, null, 2));
  console.log(JSON.stringify({ results, errors, actualModelInvoked: false }, null, 2));
} finally { await browser.close(); }
