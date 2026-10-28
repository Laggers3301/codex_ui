import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium, expect } from "@playwright/test";

const children = [], errors = [];
let browser;
const start = (args, env = {}) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  return child;
};
const ready = (child, parse) => new Promise((resolve, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error("fixture startup timeout: " + output.slice(-1000))), 15000);
  child.stdout.on("data", chunk => {
    output += chunk;
    const result = parse(output);
    if (result) { clearTimeout(timer); resolve(result); }
  });
  child.once("exit", code => { clearTimeout(timer); reject(new Error("fixture exited: " + code)); });
});

try {
  const backend = start(["--import", "tsx/esm", "tests/boundSideChats.server.ts"]);
  const meta = await ready(backend, output => output.split("\n").flatMap(line => {
    try { const item = JSON.parse(line); return item.ready ? [item] : []; } catch { return []; }
  })[0]);
  const vite = start(["--max-old-space-size=768", "node_modules/vite/bin/vite.js", "--config", "tests/boundSideChats.vite.config.mjs"], { BOUND_SIDE_CHAT_TEST_BACKEND: meta.origin });
  await ready(vite, output => output.includes("http://127.0.0.1:5212/"));
  const origin = "http://127.0.0.1:5212";
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.request.post(origin + "/api/auth/login");
  await context.addInitScript(projectId => {
    localStorage.setItem("codex-web-user-id", "admin");
    localStorage.setItem("codex-v2-project-admin", projectId);
    localStorage.setItem("codex-v2-expanded-projects-admin", JSON.stringify([projectId]));
  }, meta.projectId);
  const state = async () => (await context.request.get(origin + "/api/__test/state")).json();
  const complete = async threadId => context.request.post(origin + "/api/__test/complete", { data: { threadId } });

  for (const [threadId, quote, prompt] of [
    ["main-a", "第一段正文用于主会话 A 的侧边提问。", ""],
    ["main-b", "第二段正文用于主会话 B 的侧边提问。", "请查看附件"],
  ]) {
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    const filename = `${threadId}-handoff.md`;
    const file = { name: filename, path: `/tmp/fixture-uploads/${filename}`, relativePath: `/tmp/fixture-uploads/${filename}`, size: 6, mime: "text/markdown", rawUrl: `/api/fixture-uploads/${filename}` };
    // Exercise the real upload handler and real REST/WebSocket persistence.
    // Only file transport and the older-page boundary are simulated here.
    await page.route("**/files/upload", route => route.fulfill({ json: { data: [file] } }));
    let cropUploadTurn = false, uploadedTurnId, croppedReads = 0;
    await page.route(`**/api/threads/${threadId}?*`, async route => {
      const response = await route.fetch(), body = await response.json();
      uploadedTurnId ??= body.thread.turns.find(turn => turn.items.some(item => item.type === "userMessage" && String(item.text).includes(file.relativePath)))?.id;
      if (cropUploadTurn) {
        body.thread.turns = body.thread.turns.filter(turn => turn.id !== uploadedTurnId);
        body.history = { totalItems: 1500, returnedItems: 128, nextBefore: 128, hasOlder: true };
        croppedReads++;
      }
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${origin}/?project=${meta.projectId}&thread=${threadId}`, { waitUntil: "domcontentloaded" });
    const messages = page.locator("#conversation-messages");
    await messages.getByText(quote, { exact: true }).waitFor();
    const input = page.locator('.composer:not(.temporaryAskComposer) [contenteditable="true"]').first();
    await page.locator('input[type="file"]').first().setInputFiles({ name: filename, mimeType: "text/markdown", buffer: Buffer.from("# test") });
    await expect(page.locator(".uploadCount")).toContainText("已上传");
    if (prompt) await input.fill(prompt);
    await input.press("Enter");
    await expect.poll(async () => (await state()).starts.filter(start => start.threadId === threadId).length).toBe(1);
    await complete(threadId);
    await expect.poll(() => uploadedTurnId).toBeTruthy();
    await expect(messages.locator(`[data-turn-id="${uploadedTurnId}"] .persistedUserAttachment`)).toHaveCount(1);
    // A fresh tail page eventually omits this older upload turn in a long
    // conversation. Its optimistic copy must already have been retired.
    const nextPrompt = `${threadId} 附件上传后的下一条提问`;
    await input.fill(nextPrompt);
    await input.press("Enter");
    await expect.poll(async () => (await state()).starts.filter(start => start.threadId === threadId).length).toBe(2);
    cropUploadTurn = true;
    await complete(threadId);
    await expect.poll(() => croppedReads).toBeGreaterThan(0);
    await expect(messages.locator(`[data-turn-id="${uploadedTurnId}"]`)).toHaveCount(0);
    await expect(messages.getByText(nextPrompt, { exact: true })).toHaveCount(1);
    await expect(messages.locator(".messageItem.pending")).toHaveCount(0);
    await expect(messages.getByText(filename, { exact: true })).toHaveCount(0);

    cropUploadTurn = false;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(`[data-thread-id="${threadId}"] .threadSelectButton`).click();
    await expect(messages.locator(`[data-turn-id="${uploadedTurnId}"] .persistedUserAttachment`)).toHaveCount(1);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ isolatedDatabase: true, mockModelOnly: true, uploadOnly: true, promptWithUpload: true, noOrphanSendingBubbleAfterPagination: true, persistedAttachmentsRetained: true, errors }));
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
