import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { chromium } from "@playwright/test";
const children = [];
let browser;
const start = (args, env = {}) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child); child.stderr.on("data", chunk => process.stderr.write(chunk)); return child;
};
const ready = (child, pattern) => new Promise((resolve, reject) => {
  let text = "";
  const timer = setTimeout(() => reject(new Error("fixture startup timeout: " + text.slice(-500))), 20000);
  child.stdout.on("data", chunk => { text += chunk; const result = pattern(text); if (result) { clearTimeout(timer); resolve(result); } });
  child.once("exit", code => { clearTimeout(timer); reject(new Error("fixture exit " + code)); });
});
const evidence = "../data/backend/side-chat-dock-20261024";
await fs.mkdir(evidence, { recursive: true });
try {
  const backend = start(["--import", "tsx/esm", "tests/boundSideChats.server.ts"]);
  const meta = await ready(backend, output => output.split("\n").flatMap(line => { try { const item = JSON.parse(line); return item.ready ? [item] : []; } catch { return []; } })[0]);
  const vite = start(["--max-old-space-size=768", "node_modules/vite/bin/vite.js", "--config", "tests/boundSideChats.vite.config.mjs"], { BOUND_SIDE_CHAT_TEST_BACKEND: meta.origin });
  await ready(vite, output => output.includes("http://127.0.0.1:5212/"));
  browser = await chromium.launch({ headless: true });
  const results = [], errors = [];
  for (const theme of ["dark", "light"]) for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 393, height: 852 } : { width: 1600, height: 1000 } });
    await context.request.post("http://127.0.0.1:5212/api/auth/login");
    await context.addInitScript(({ project, theme, mobile }) => {
      localStorage.setItem("codex-web-user-id", "admin");
      localStorage.setItem("codex-v2-project-admin", project);
      localStorage.setItem("codex-v2-expanded-projects-admin", JSON.stringify([project]));
      localStorage.setItem("codex-web-diff-panel-width", "390");
    }, { project: meta.projectId, theme, mobile });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:5212/?project=${meta.projectId}&thread=main-a`);
    const quote = page.locator("#conversation-messages").getByText("第一段正文用于主会话 A 的侧边提问。", { exact: true });
    await quote.waitFor();
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    if (!(await page.getByRole("complementary", { name: "临时侧边对话" }).count())) {
    await quote.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.getByRole("button", { name: "在侧边提问", exact: true }).click();
    }
    const panel = page.getByRole("complementary", { name: "临时侧边对话" });
    await panel.locator('[contenteditable="true"]').fill("保持输入草稿，暂不发给模型");
    await page.waitForTimeout(400);
    const geometry = await panel.locator(".temporaryAskComposerTools").evaluate(element => {
      const row = element.getBoundingClientRect();
      return [...element.children].map(child => { const box = child.getBoundingClientRect(); return { left: box.left, right: box.right, center: (box.top + box.bottom) / 2, within: box.left >= row.left - 1 && box.right <= row.right + 1 }; });
    });
    assert.equal(geometry.length, 3);
    assert.ok(geometry.every(item => item.within), "all controls fit the narrow side composer: " + JSON.stringify(geometry));
    assert.ok(geometry[0].right <= geometry[1].left && geometry[1].right <= geometry[2].left, "access, model and send stay in order without overlap");
    assert.ok(Math.max(...geometry.map(item => item.center)) - Math.min(...geometry.map(item => item.center)) <= 2, "send/model/access share one center line");
    assert.equal(await panel.evaluate(element => Boolean(element.closest("#right-pane-side-chat"))), true);
    const marker = page.locator(".promptNavigator");
    if (await marker.count()) assert.equal(await marker.getAttribute("aria-hidden"), "true");
    await page.screenshot({ path: `${evidence}/${theme}-${mobile ? "mobile" : "desktop"}-side.png` });
    await page.locator(".rightWorkspaceBar").getByRole("button", { name: "隐藏右栏", exact: true }).click();
    await page.waitForTimeout(450);
    await page.getByRole("button", { name: "显示右栏", exact: true }).click();
    assert.equal(await panel.locator('[contenteditable="true"]').innerText(), "保持输入草稿，暂不发给模型");
    await page.locator(".rightWorkspaceBar").getByRole("button", { name: "隐藏右栏", exact: true }).click();
    if (mobile) {
      await page.setViewportSize({ width: 1100, height: 900 });
      const expand = page.getByRole("button", { name: "展开侧边栏", exact: true });
      if (await expand.isVisible()) await expand.click();
    }
    await page.getByRole("button", { name: "新建对话", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "选择新对话的工作区" });
    await dialog.waitFor();
    const typography = await dialog.evaluate(element => ({
      heading: getComputedStyle(element.querySelector("header strong")).fontSize,
      row: getComputedStyle(element.querySelector(".newThreadProjectList button")).fontSize,
      height: element.querySelector(".newThreadProjectList button").getBoundingClientRect().height,
      bodyHeight: element.getBoundingClientRect().height
    }));
    assert.equal(typography.heading, "14px"); assert.equal(typography.row, "14px");
    assert.ok(typography.height <= 36);
    await page.screenshot({ path: `${evidence}/${theme}-${mobile ? "small" : "desktop"}-picker.png` });
    results.push({ theme, mobile, geometry, typography, docked: true, hideRestoresDraft: true, indexHidden: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(`${evidence}/results.json`, JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }));
} finally { await browser?.close(); for (const child of children.reverse()) child.kill("SIGTERM"); }
