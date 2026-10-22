// Read-only production UI checks. Never click rename/pin/archive actions.
import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url), { chromium } = require("@playwright/test");
const userId = process.env.QA_USER_ID, projectId = process.env.QA_PROJECT_ID;
if (!userId || !projectId) throw new Error("Provide an authorized QA_USER_ID and QA_PROJECT_ID");
const root = new URL("../", import.meta.url), output = new URL("data/backend/context-menu-20261021/", root);
await fs.mkdir(output, { recursive: true });
const secret = (await fs.readFile(new URL("data/auth/session-secret", root), "utf8")).trim();
const p = Buffer.from(JSON.stringify({ u: userId, exp: Date.now() + 300000 })).toString("base64url");
const value = p + "." + createHmac("sha256", secret).update(p).digest("base64url");
const browser = await chromium.launch({ ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const results = [], errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  await context.addCookies([{ name: "codex_remote_session_4575", value, url: "http://127.0.0.1:4574", httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ userId, projectId }) => {
    localStorage.setItem("codex-web-user-id", userId);
    localStorage.setItem(`codex-v2-project-${userId}`, projectId);
    localStorage.setItem(`codex-v2-expanded-projects-${userId}`, JSON.stringify([projectId]));
  }, { userId, projectId });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:4574/", { waitUntil: "domcontentloaded" });
  const row = page.locator(`.v2WorkspaceGroup[data-project-id="${projectId}"] .threadRow .threadSelectButton`).first();
  await row.waitFor({ timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  const typography = element => { const s = getComputedStyle(element); return { size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeight, family: s.fontFamily }; };
  const sidebar = await row.locator("strong").evaluate(typography);
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await row.click({ button: "right" });
    const menu = page.locator(".compactThreadContextMenu");
    await menu.waitFor();
    const style = await menu.evaluate(element => ({ animation: getComputedStyle(element).animationName, easing: getComputedStyle(element).animationTimingFunction }));
    assert.equal(style.animation, "threadMenuEnter");
    const text = await menu.getByRole("menuitem").first().evaluate(typography);
    assert.equal(text.size, sidebar.size); assert.equal(text.weight, sidebar.weight); assert.equal(text.lineHeight, sidebar.lineHeight); assert.equal(text.family, sidebar.family);
    const bounds = await menu.boundingBox();
    assert.ok(bounds.width <= 177 && bounds.height <= 132);
    await page.waitForTimeout(240);
    await page.screenshot({ path: new URL(`${theme}-open.png`, output).pathname });
    await page.keyboard.press("Escape");
    await page.locator(".compactThreadContextMenu.closing").waitFor({ state: "attached" });
    assert.equal(await menu.getAttribute("inert"), "");
    await menu.waitFor({ state: "detached", timeout: 1000 });
    await row.click({ button: "right" });
    await menu.waitFor();
    await page.locator(".v2BrandRow strong").click();
    await menu.waitFor({ state: "detached", timeout: 1000 });
    results.push({ theme, sidebar, menu: text, bounds, enter: style, escapeAndOutsideExit: true });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await row.click({ button: "right" });
  assert.equal(await page.locator(".compactThreadContextMenu").evaluate(element => getComputedStyle(element).animationName), "none");
  await page.keyboard.press("Escape");
  await page.locator(".compactThreadContextMenu").waitFor({ state: "detached", timeout: 1000 });
  assert.deepEqual(errors, []);
  await fs.writeFile(new URL("results.json", output), JSON.stringify({ results, reducedMotion: true, errors }, null, 2));
  console.log(JSON.stringify({ results, reducedMotion: true, errors }, null, 2));
} finally { await browser.close(); }
