import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const children = [], errors = [];
let browser;
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
const evidence = "output/qa/approvals-20261027";
await fs.mkdir(evidence, { recursive: true });
try {
  const backend = start(["--import", "tsx/esm", "tests/boundSideChats.server.ts"]);
  const meta = await ready(backend, output => output.split("\n").flatMap(line => { try { const item = JSON.parse(line); return item.ready ? [item] : []; } catch { return []; } })[0]);
  const vite = start(["--max-old-space-size=768", "node_modules/vite/bin/vite.js", "--config", "tests/boundSideChats.vite.config.mjs"], { BOUND_SIDE_CHAT_TEST_BACKEND: meta.origin });
  await ready(vite, output => output.includes("http://127.0.0.1:5212/"));
  const origin = "http://127.0.0.1:5212";
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  await context.request.post(origin + "/api/auth/login");
  await context.addInitScript(project => {
    localStorage.setItem("codex-web-user-id", "admin"); localStorage.setItem("codex-v2-project-admin", project);
    localStorage.setItem("codex-v2-expanded-projects-admin", JSON.stringify([project]));
  }, meta.projectId);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const post = async (name, data) => { const response = await context.request.post(origin + "/api/__test/" + name, { data }); assert.ok(response.ok()); return response.json(); };
  const state = async () => (await context.request.get(origin + "/api/__test/state")).json();
  const quote = "第一段正文用于主会话 A 的侧边提问。";
  await page.goto(`${origin}/?project=${meta.projectId}&thread=main-a`, { waitUntil: "domcontentloaded" });
  await page.locator("#conversation-messages").getByText(quote, { exact: true }).waitFor();
  await post("start-main", { threadId: "main-a" });
  await post("approval", { threadId: "main-a", kind: "commandExecution", emit: false });
  const approvals = page.getByRole("region", { name: "待批准操作", exact: true });
  await expect(approvals).toContainText("页面尚未收到具体操作和批准按钮");
  assert.equal((await state()).approvalResponses.length, 0);
  await approvals.getByRole("button", { name: "重新核对批准请求", exact: true }).click();
  const command = page.getByRole("alert", { name: "批准命令执行", exact: true });
  await expect(command).toContainText("git fetch origin lzc"); await expect(command).toContainText("工作目录");
  await post("approval", { threadId: "main-a", kind: "permissions" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-thread-id="main-a"] .threadSelectButton').click();
  const permissions = page.getByRole("alert", { name: "批准权限申请", exact: true });
  await expect(command).toBeVisible(); await expect(permissions).toContainText("/tmp/approval-fixture");
  await page.setViewportSize({ width: 393, height: 852 });
  const collapseForCards = page.getByRole("button", { name: "折叠侧边栏", exact: true });
  if (await collapseForCards.isVisible()) await collapseForCards.click();
  const cardBox = await approvals.boundingBox();
  assert.ok(cardBox && cardBox.x >= -1 && cardBox.x + cardBox.width <= 394 && cardBox.height <= 427);
  await page.screenshot({ path: `${evidence}/phone-pending-approvals.png` });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await permissions.getByRole("button", { name: "允许本轮所列权限", exact: true }).click();
  await expect(permissions).toHaveCount(0); await expect(command).toBeVisible();
  const response = (await state()).approvalResponses[0];
  assert.equal(response.result.scope, "turn"); assert.deepEqual(response.result.permissions.fileSystem.read, ["/tmp/approval-fixture"]);
  await post("fail-next-approval", {}); await command.getByRole("button", { name: "仅批准这次", exact: true }).click();
  await expect(page.getByText("批准操作失败：模拟批准提交失败，请重试", { exact: true })).toBeVisible();
  await expect(command.getByRole("button", { name: "仅批准这次", exact: true })).toBeEnabled();
  assert.equal((await state()).approvalResponses.length, 1);
  await command.getByRole("button", { name: "拒绝", exact: true }).click(); await expect(command).toHaveCount(0);
  assert.deepEqual((await state()).approvalResponses[1].result, { decision: "decline" });

  await post("approval-state", { threadId: "main-a", waiting: true, clearRequests: true });
  await approvals.getByRole("button", { name: "重新核对批准请求", exact: true }).click();
  await expect(approvals).toContainText("未返回可操作的批准请求");
  const layouts = [];
  for (const mobile of [false, true]) {
    await page.setViewportSize(mobile ? { width: 393, height: 852 } : { width: 1600, height: 1000 });
    const collapse = page.getByRole("button", { name: "折叠侧边栏", exact: true }); if (mobile && await collapse.isVisible()) await collapse.click();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, mobile ? "light" : "dark");
    const box = await approvals.boundingBox(), viewport = page.viewportSize();
    assert.ok(box && box.x >= -1 && box.x + box.width <= viewport.width + 1);
    assert.ok(await approvals.evaluate(element => { const b = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(b.x + b.width / 2, b.y + 10)); }));
    await page.screenshot({ path: `${evidence}/${mobile ? "phone-light" : "desktop-dark"}.png` }); layouts.push({ mobile, withinViewport: true });
  }
  await post("approval-state", { threadId: "main-a", waiting: false }); await expect(approvals).toHaveCount(0);
  await post("complete", { threadId: "main-a" });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator("#conversation-messages").getByText(quote, { exact: true }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "在侧边提问", exact: true }).click();
  const editor = page.locator('.temporaryAskComposer [contenteditable="true"]');
  await editor.fill("测试侧边会话批准"); await page.getByRole("button", { name: "发送临时提问", exact: true }).click();
  await expect.poll(async () => (await state()).sides[0]?.threadId).toBeTruthy();
  const sideThreadId = (await state()).sides[0].threadId;
  await post("approval", { threadId: sideThreadId, kind: "commandExecution" });
  const sideCommand = page.locator(".temporaryAskComposer").getByRole("alert", { name: "批准命令执行", exact: true });
  await expect(sideCommand).toContainText("git fetch origin lzc");
  await sideCommand.getByRole("button", { name: "拒绝", exact: true }).click(); await expect(sideCommand).toHaveCount(0);
  assert.equal((await state()).starts.length, 2, "inspections and approval choices must never start extra model turns");
  assert.deepEqual(errors, []);
  const result = { missingDetailsExplained: true, readOnlyRefresh: true, permissionRequestRestoredAfterReload: true, secondApprovalPreserved: true, turnScopedPermissionGrant: true, failedResponseRetainsCard: true, staleWaitCleared: true, sideChatApprovalVisible: true, noExtraModelTurns: true, layouts, errors };
  await fs.writeFile(`${evidence}/results.json`, JSON.stringify(result, null, 2) + "\n"); console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  for (const child of children.reverse()) { if (child.exitCode !== null) continue; const closed = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await closed; }
}
