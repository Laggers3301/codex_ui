import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { setContentViewport } from "./contentViewport.mjs";

const children = [], errors = [], interrupts = [];
let browser, failureState;
const evidence = process.env.SIDE_CHAT_STOP_EVIDENCE ?? "output/qa/side-chat-stop";
await fs.mkdir(evidence, { recursive: true });
const start = (args, env = {}) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); child.stderr.on("data", chunk => process.stderr.write(chunk)); return child;
};
const ready = (child, parse) => new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error("fixture startup timeout: " + output.slice(-1000))), 30000);
  child.stdout.on("data", chunk => { output += chunk; const result = parse(output); if (result) { clearTimeout(timer); resolve(result); } });
  child.once("exit", code => { clearTimeout(timer); reject(new Error("fixture exited: " + code)); });
});
const quotes = { "main-a": "第一段正文用于主会话 A 的侧边提问。", "main-b": "第二段正文用于主会话 B 的侧边提问。" };
const panel = page => page.getByRole("complementary", { name: "临时侧边对话" });
const composer = page => panel(page).locator('[contenteditable="true"]');
const stop = page => panel(page).getByRole("button", { name: "终止侧边对话", exact: true });
async function selectQuote(page, text) {
  await page.locator("#conversation-messages").getByText(text, { exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "在侧边提问", exact: true }).click();
}
async function switchMain(page, id) {
  await page.locator(`[data-thread-id="${id}"] .threadSelectButton`).click();
  await expect(page.locator("#conversation-messages").getByText(quotes[id], { exact: true })).toBeVisible();
}
async function submit(page, text) {
  await composer(page).fill(text); await composer(page).press("Enter");
}

try {
  const backend = start(["--import", "tsx/esm", "tests/boundSideChats.server.ts"]);
  const meta = await ready(backend, output => output.split("\n").flatMap(line => { try { const value = JSON.parse(line); return value.ready ? [value] : []; } catch { return []; } })[0]);
  const vite = start(["--max-old-space-size=768", "node_modules/vite/bin/vite.js", "--config", "tests/boundSideChats.vite.config.mjs"], { BOUND_SIDE_CHAT_TEST_BACKEND: meta.origin });
  await ready(vite, output => output.includes("http://127.0.0.1:5212/"));
  const origin = "http://127.0.0.1:5212";
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.request.post(origin + "/api/auth/login");
  await context.addInitScript(projectId => {
    localStorage.setItem("codex-web-user-id", "admin"); localStorage.setItem("codex-v2-project-admin", projectId);
    localStorage.setItem("codex-v2-expanded-projects-admin", JSON.stringify([projectId]));
  }, meta.projectId);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
    try { const message = JSON.parse(String(payload)); if (message.type === "turn.interrupt") interrupts.push(message); } catch {}
  }));
  const post = async (name, data = {}) => { const result = await context.request.post(origin + "/api/__test/" + name, { data }); assert.equal(result.status(), 200); };
  const state = async () => (await context.request.get(origin + "/api/__test/state")).json();
  failureState = state;
  const side = async parent => (await state()).sides.find(item => item?.parentThreadId === parent);
  const running = async parent => expect.poll(async () => (await side(parent))?.status).toBe("running");
  const complete = async parent => expect.poll(async () => (await side(parent))?.status).toBe("complete");
  await page.goto(`${origin}/?project=${meta.projectId}&thread=main-a`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#conversation-messages").getByText(quotes["main-a"], { exact: true })).toBeVisible();
  await post("start-main", { threadId: "main-a" });
  await selectQuote(page, quotes["main-a"]);
  await submit(page, "保留已经生成的侧边回答"); await running("main-a");
  const a = await side("main-a");
  await expect(stop(page)).toBeEnabled();
  await expect(panel(page).getByText(/侧边回答 \d+：保留已经生成的侧边回答/)).toBeVisible();
  await post("hold-interrupt", { pause: true });
  await stop(page).click(); await expect(stop(page)).toBeDisabled();
  await expect(panel(page)).toContainText("正在停止");
  assert.equal(interrupts.length, 1); assert.equal(interrupts[0].threadId, a.threadId); assert.equal(interrupts[0].turnId, a.turnId);
  await expect(page.getByRole("button", { name: "终止当前对话", exact: true })).toBeEnabled();
  await post("hold-interrupt", { pause: false }); await complete("main-a");
  await expect(panel(page).getByRole("button", { name: "发送临时提问", exact: true })).toBeVisible();
  await expect(panel(page).getByText(/侧边回答 \d+：保留已经生成的侧边回答/)).toBeVisible();
  await submit(page, "停止以后继续提问"); await running("main-a");
  assert.equal((await side("main-a")).threadId, a.threadId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await switchMain(page, "main-a");
  await expect(stop(page)).toBeEnabled();
  await setContentViewport(page, { width: 393, height: 780 });
  await expect(stop(page)).toBeInViewport();
  await page.screenshot({ path: evidence + "/mobile-stop.png" });
  await stop(page).click(); await complete("main-a");
  await setContentViewport(page, { width: 1600, height: 1000 });
  await submit(page, "停止失败仍能重试"); await running("main-a");
  await post("fail-next-interrupt"); await stop(page).click();
  await expect(page.locator(".errorBanner")).toContainText("模拟侧边会话停止失败，请重试");
  await expect(stop(page)).toBeEnabled(); assert.equal((await side("main-a")).status, "running");
  await expect(panel(page)).toContainText("停止失败仍能重试");
  await stop(page).click(); await complete("main-a");

  await submit(page, "A 的侧边会话继续运行"); await running("main-a");
  await switchMain(page, "main-b"); await post("start-main", { threadId: "main-b" });
  await selectQuote(page, quotes["main-b"]); await post("hold-create", { pause: true });
  await submit(page, "B 在建立会话时停止");
  await expect(panel(page)).toContainText("正在建立临时会话");
  const beforePending = interrupts.length;
  await stop(page).click(); await expect(stop(page)).toBeDisabled();
  assert.equal(interrupts.length, beforePending, "no interrupt is sent before the side thread/turn exists");
  await switchMain(page, "main-a"); await expect(stop(page)).toBeEnabled();
  await post("hold-create", { pause: false }); await complete("main-b");
  const b = await side("main-b");
  await expect.poll(() => interrupts.length).toBe(beforePending + 1); assert.equal(interrupts.at(-1).threadId, b.threadId);
  assert.equal((await side("main-a")).status, "running");
  await expect(page.getByRole("button", { name: "终止当前对话", exact: true })).toBeEnabled();
  await switchMain(page, "main-b");
  await expect(panel(page).getByText(/侧边回答 \d+：B 在建立会话时停止/)).toBeVisible();
  await post("hold-turn-start", { pause: true }); await submit(page, "B 的后续轮次在启动时停止");
  await expect(panel(page)).toContainText("正在建立临时会话");
  await stop(page).click(); await expect(stop(page)).toBeDisabled();
  await switchMain(page, "main-a"); await post("hold-turn-start", { pause: false }); await complete("main-b");
  assert.equal(interrupts.at(-1).threadId, b.threadId); assert.equal((await side("main-a")).status, "running");
  assert.ok(interrupts.every(message => [a.threadId, b.threadId].includes(message.threadId)), "side stops never address either main thread");

  // The main stop control still addresses only the main turn.
  await page.getByRole("button", { name: "终止当前对话", exact: true }).click();
  await expect.poll(() => interrupts.at(-1)?.threadId).toBe("main-a");
  assert.equal((await side("main-a")).status, "running");
  await stop(page).click(); await complete("main-a");
  await expect(panel(page)).toContainText("A 的侧边会话继续运行");
  const final = await state();
  assert.equal(final.calls.filter(call => call.method === "thread/fork").length, 2, "stopping preserves both bound side threads");
  assert.deepEqual(errors, []);
  const result = { isolatedDatabase: true, realRestAndWebsocket: true, mockModelOnly: true, runningSideCanStop: true,
    pendingStopDisabled: true, partialAnswerPreserved: true, stoppedSideCanContinue: true, reloadRestoresStop: true,
    mobileStopClickable: true, failureCanRetry: true, queuedCreationStop: true, queuedFollowupStop: true,
    backgroundStopTargetsOriginalSide: true, mainAndOtherSideUnaffected: true, mainStopStillWorks: true, pageErrors: errors };
  await fs.writeFile(evidence + "/result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} catch (error) {
  await fs.writeFile(evidence + "/failure-state.json", JSON.stringify({ state: await failureState?.(), interrupts }, null, 2)).catch(() => {});
  for (const page of browser?.contexts().flatMap(context => context.pages()) ?? [])
    await page.screenshot({ path: evidence + "/failure.png" }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]); clearTimeout(timer);
  }
}
