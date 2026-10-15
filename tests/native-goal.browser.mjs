// Real, bounded Goal kickoff against an authorized user's isolated QA project.
// No auth.json access, forced OAuth renewal, or changes to existing conversations.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import WebSocket from "ws";

const url = process.env.NATIVE_GOAL_QA_URL || "http://127.0.0.1:4575";
const username = process.env.DOCUMENT_QA_USER || "qaUser";
if (!process.env.DOCUMENT_QA_PASSWORD) throw new Error("Set the authorized QA login password.");
const root = await fs.mkdtemp(path.join(process.env.DOCUMENT_QA_ROOT || process.cwd(), "goal-kickoff-qa-"));
const screenshots = await fs.mkdtemp("/tmp/codex-native-goal-");
const browser = await chromium.launch({ executablePath: process.env.DOCUMENT_QA_CHROMIUM || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let ws;
let threadId;
const messages = [];
const pending = new Map();
function request(type, extra = {}) {
  const requestId = `qa-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} acknowledgement timeout`)); }, 60_000);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type, requestId, ...extra }));
  });
}
async function waitUntil(predicate, description, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${description}`);
}
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const login = await context.request.post(`${url}/api/auth/login`, { data: { username, password: process.env.DOCUMENT_QA_PASSWORD } });
  assert.equal(login.status(), 200, "authorized QA login");
  const created = await context.request.post(`${url}/api/projects`, { data: { name: "Goal 启动验收", rootPath: root, defaultModel: "gpt-6-luna", defaultReasoningEffort: "low", defaultApprovalPolicy: "never", defaultSandbox: "workspace-write" } });
  assert.ok(created.ok(), "isolated QA project creation");
  const project = (await created.json()).data;
  const cookies = await context.cookies(url);
  const headers = { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") };
  const socketUrl = new URL("/ws", url); socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(socketUrl, { headers });
  await new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", raw => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (messages.length > 500) messages.shift();
      if (message.type === "hello") resolve();
      const entry = pending.get(message.requestId);
      if (entry && ["ack", "error"].includes(message.type)) {
        pending.delete(message.requestId); clearTimeout(entry.timer);
        if (message.ok === false || message.type === "error") entry.reject(new Error(`${message.type}: ${String(message.error || "request failed").slice(0, 250)}`));
        else entry.resolve(message);
      }
    });
  });
  const start = await request("thread.start", { projectId: project.id, model: "gpt-6-luna", reasoningEffort: "low", approvalPolicy: "never", sandbox: "workspace-write", prompt: "这是隔离 QA。只回复 READY，不要调用工具、读取或修改任何文件。" });
  threadId = start.data.thread.thread.id;
  const warmupTurn = start.data.turn.turn.id;
  await waitUntil(() => messages.some(message => message.type === "codex.notification" && message.data?.method === "turn/completed" && message.data?.params?.threadId === threadId && message.data?.params?.turn?.id === warmupTurn), "QA warmup turn completion");
  const proofName = "goal-proof.txt";
  const marker = `goal-kickoff-${randomUUID()}`;
  const result = await request("goal.set", { threadId, objective: `这是一次隔离 Goal 接口测试。只在当前工作区创建 ${proofName}，内容严格为 ${marker}。用一个普通文件写入工具即可，不要读取其他目录或调用子代理。确认文件写入后将本 Goal 标为 complete 并结束。` });
  assert.ok(["started", "running"].includes(result.data.execution?.state), "Goal acknowledgement confirms actual turn startup, not merely persistence");
  await waitUntil(async () => {
    try { return (await fs.readFile(path.join(root, proofName), "utf8")).trim() === marker; }
    catch { return false; }
  }, "Goal kickoff creates the scoped proof file");
  await waitUntil(() => messages.some(message => message.type === "codex.notification" && message.data?.method === "thread/goal/updated" && message.data?.params?.threadId === threadId && message.data?.params?.goal?.status === "complete"), "Goal completes via native update");
  const goalTurnId = result.data.execution?.turnId;
  if (goalTurnId) await waitUntil(() => messages.some(message => message.type === "codex.notification" && message.data?.method === "turn/completed" && message.data?.params?.threadId === threadId && message.data?.params?.turn?.id === goalTurnId), "Goal kickoff turn finishes without leaving a QA run active");
  const persisted = await request("goal.get", { threadId });
  assert.equal(persisted.data.goal?.status, "complete");
  console.log(JSON.stringify({ phase: "native_execution_verified", projectId: project.id, threadId, root, execution: result.data.execution.state, persistedStatus: "complete" }));
  await context.addInitScript(({ username }) => {
    localStorage.setItem("codex-web-user-id", username);
    localStorage.setItem("codex-web-color-theme", "dark");
    localStorage.setItem("codex-web-thread-list-collapsed", "true");
  }, { username });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${url}/?project=${encodeURIComponent(project.id)}&thread=${encodeURIComponent(threadId)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".goalProgressStatus")).toHaveText("持续目标 · 已完成", { timeout: 60_000 });
  await expect(page.locator(".goalProgressStatus")).toBeVisible();
  await expect(page.locator(".goalProgress .threadActivityIcon svg").first()).toHaveAttribute("viewBox", "0 0 48 48");
  await expect(page.locator(".goalProgress .threadActivityIcon").first()).toHaveCSS("width", "16px");
  await page.waitForTimeout(350); // Capture the settled reveal, not its zero-height first frame.
  await page.screenshot({ path: path.join(screenshots, "mobile-native-goal.png") });
  assert.deepEqual(errors, []);
  await request("goal.clear", { threadId });
  threadId = undefined;
  console.log(JSON.stringify({ result: "PASS", projectId: project.id, root, screenshots, execution: result.data.execution.state, proofFile: proofName, persistedStatus: "complete" }));
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0];
  if (page) await page.screenshot({ path: path.join(screenshots, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ phase: "qa_failure", screenshots, error: String(error).slice(0, 400) }));
  throw error;
} finally {
  if (threadId && ws?.readyState === WebSocket.OPEN) await request("goal.clear", { threadId }).catch(() => {});
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("QA closed")); }
  ws?.close();
  await browser.close();
}
