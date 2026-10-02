// Read-only production hover check: never set/clear a Goal or start a turn.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const url = process.env.GOAL_HOVER_QA_URL || "http://127.0.0.1:4575";
const threadId = process.env.GOAL_HOVER_QA_THREAD;
const username = process.env.DOCUMENT_QA_USER || "qaUser";
if (!process.env.DOCUMENT_QA_PASSWORD) throw new Error("Authorized read-only QA login required.");
const screenshots = await fs.mkdtemp("/tmp/codex-goal-hover-public-");
const browser = await chromium.launch({ executablePath: process.env.DOCUMENT_QA_CHROMIUM || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "no-preference" });
  const login = await context.request.post(`${url}/api/auth/login`, { data: { username, password: process.env.DOCUMENT_QA_PASSWORD } });
  assert.ok(login.ok(), "authorized login");
  const thread = await context.request.get(`${url}/api/threads/${threadId}`);
  assert.ok(thread.ok(), "owned conversation is readable");
  const snapshot = (await thread.json()).thread;
  const projectsResponse = await context.request.get(`${url}/api/projects`);
  assert.ok(projectsResponse.ok());
  const projects = (await projectsResponse.json()).data;
  const project = projects.find(project => project.rootPath === snapshot.cwd);
  assert.ok(project, "owned workspace for the conversation");
  await context.addInitScript(({ username }) => {
    localStorage.setItem("codex-web-user-id", username);
    localStorage.setItem("codex-web-color-theme", "dark");
    localStorage.setItem("codex-web-thread-list-collapsed", "true");
  }, { username });
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${url}/?project=${encodeURIComponent(project.id)}&thread=${encodeURIComponent(threadId)}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".goalProgressStatus")).toBeVisible({ timeout: 60000 });
  const row = page.locator(".goalProgressRow");
  const buttons = row.locator(":scope > button");
  await expect(buttons).toHaveCount(4);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (let index = 0; index < 4; index += 1) {
      const button = buttons.nth(index);
      await page.mouse.move(5, 5);
      await page.waitForTimeout(340);
      const idleColor = await button.evaluate(element => getComputedStyle(element).color);
      await button.hover({ force: true });
      await page.waitForTimeout(340);
      const style = await button.evaluate(element => {
        const computed = getComputedStyle(element);
        return { color: computed.color, background: computed.backgroundColor, radius: parseFloat(computed.borderRadius), property: computed.transitionProperty, duration: computed.transitionDuration, ease: computed.transitionTimingFunction, disabled: element.disabled };
      });
      assert.equal(style.color, idleColor);
      assert.ok(style.radius >= 8);
      assert.equal(style.property, "background-color");
      assert.equal(style.duration, "0.3s");
      assert.match(style.ease, /cubic-bezier/);
      const channels = style.background.match(/[\d.]+/g)?.map(Number);
      assert.equal(channels[0], channels[1]);
      assert.equal(channels[1], channels[2]);
      assert.equal(channels[3], style.disabled ? 0 : theme === "light" ? .035 : .04);
      await page.screenshot({ path: `${screenshots}/${theme}-${index}.png` });
      await page.mouse.move(5, 5);
      await page.waitForTimeout(340);
      await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const collapse = page.getByRole("button", { name: "折叠侧边栏", exact: true });
    if (await collapse.isVisible()) await collapse.click();
    await expect(row).toBeInViewport();
    await expect(buttons.nth(3)).toBeInViewport();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${screenshots}/mobile-${theme}.png` });
    await page.setViewportSize({ width: 1440, height: 960 });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", url, screenshots, checks: "all four hover controls in both themes; mobile containment; no conversation mutations" }));
} finally { await browser.close(); }
