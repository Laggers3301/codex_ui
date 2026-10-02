// Read-only UI verification using an existing, owned QA workspace. No model
// turns, file edits, compilation or production conversation changes.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const username = process.env.DOCUMENT_QA_USER || "qaUser";
const url = process.env.DOCUMENT_QA_URL || "http://127.0.0.1:4575";
const projectId = process.env.DOCUMENT_QA_PROJECT;
const inspect = process.env.WRITING_TYPOGRAPHY_INSPECT === "1";
if (!process.env.DOCUMENT_QA_PASSWORD) throw new Error("Authorized QA login required.");
const screenshots = await fs.mkdtemp("/tmp/codex-writing-typography-");
const browser = await chromium.launch({ executablePath: process.env.DOCUMENT_QA_CHROMIUM || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1560, height: 960 }, reducedMotion: "no-preference" });
  const login = await context.request.post(`${url}/api/auth/login`, { data: { username, password: process.env.DOCUMENT_QA_PASSWORD } });
  assert.ok(login.ok());
  await context.addInitScript(username => { localStorage.setItem("codex-web-user-id", username); localStorage.setItem("codex-web-color-theme", "light"); localStorage.setItem("codex-web-thread-list-collapsed", "false"); }, username);
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const settle = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      for (let pass = 0; pass < 3; pass++) {
        await frame();
        const animations = document.getAnimations().filter(animation => {
          const timing = animation.effect?.getComputedTiming();
          return animation.playState === "running" && timing && Number.isFinite(timing.iterations);
        });
        if (!animations.length) break;
        await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
      }
      await frame(); await frame();
    });
    await expect(page.locator(".writingWorkbench")).toHaveCSS("opacity", "1");
    if (page.viewportSize().width <= 720) {
      await expect(page.locator(".writingLayout .mobileActive")).toHaveCSS("opacity", "1");
    }
  };
  const headerLayout = () => page.locator(".writingActions").evaluate(element => [...element.children].map(child => {
    const rect = child.getBoundingClientRect();
    return { label: child.getAttribute("aria-label") || child.textContent.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
  const assertHeaderLayout = async () => {
    const layout = await headerLayout();
    assert.ok(layout.every(control => control.x >= 0 && control.x + control.width <= page.viewportSize().width), "all writing actions fit in the viewport");
    for (const icon of layout.filter(control => ["显示聊天", "关闭写作"].includes(control.label))) assert.equal(icon.width, 34, "icon hit areas must not shrink");
    if (page.viewportSize().width >= 360) assert.ok(layout.every(control => Math.abs(control.y - layout[0].y) < 1), "writing action controls stay on one row");
  };
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(`.v2WorkspaceGroup[data-project-id="${projectId}"] .projectNewThreadButton`).click();
  const collapse = page.getByRole("button", { name: "折叠侧边栏", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await page.locator(".v2ComposerPlus").click();
  await page.locator('#v2PlusMenu [data-action="writing"]').click();
  const workbench = page.locator(".writingWorkbench");
  await expect(workbench).toBeVisible();
  await expect(workbench).toHaveCSS("opacity", "1");
  await expect(page.getByRole("treeitem", { name: /paper\.tex/ })).toBeVisible();
  const sizes = selectors => page.evaluate(selectors => Object.fromEntries(selectors.map(selector => {
    const element = document.querySelector(selector);
    const computed = element && getComputedStyle(element);
    return [selector, computed ? { size: computed.fontSize, weight: computed.fontWeight, line: computed.lineHeight, font: computed.fontFamily } : null];
  })), selectors);
  const mainSelectors = [".writingWorkbench", ".writingHeading strong", ".writingHeading > span", ".writingButton", ".writingFilesHeader", ".writingTreeName", ".writingFileActions button", ".writingFileActions label", ".writingPaneTitle > span", ".writingEmpty", ".writingWelcome strong"];
  const before = await sizes(mainSelectors);
  console.log(JSON.stringify({ phase: "empty", typography: before }));
  if (!inspect) for (const [selector, value] of Object.entries(before)) assert.equal(value?.size, "13px", `unified interface type: ${selector}`);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await settle();
    await page.screenshot({ path: `${screenshots}/desktop-${theme}-empty.png` });
  }
  await page.getByRole("treeitem", { name: /paper\.tex/ }).click();
  await expect(page.locator(".writingCodeEditor .cm-content")).toContainText("\\documentclass");
  const editorSelectors = [".writingHeading strong", ".writingHeading > span", ".writingActions .writingButton", ".writingActions select", ".writingPaneTitle > span", ".writingPaneTitle > small", ".writingReferenceButton", ".writingCodeEditor .cm-content"];
  console.log(JSON.stringify({ phase: "tex", typography: await sizes(editorSelectors) }));
  if (!inspect) {
    for (const selector of editorSelectors.slice(0, 5).concat(".writingReferenceButton")) await expect(page.locator(selector).first()).toHaveCSS("font-size", "13px");
    await expect(page.locator(".writingPaneTitle > small").first()).toHaveCSS("font-size", "12px");
    await expect(page.locator(".writingCodeEditor .cm-content")).toHaveCSS("font-size", "15px");
    await expect(page.locator(".writingCodeEditor .cm-content")).toHaveCSS("font-family", /Consolas/);
  }
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width: 1560, height: 960 });
    await settle();
    console.log(JSON.stringify({ phase: `desktop-${theme}`, header: await headerLayout() }));
    await assertHeaderLayout();
    await page.screenshot({ path: `${screenshots}/desktop-${theme}-tex.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".writingCodeEditor .cm-content")).toBeInViewport();
    await settle();
    console.log(JSON.stringify({ phase: `mobile-${theme}`, header: await headerLayout() }));
    await assertHeaderLayout();
    if (!inspect) {
      await expect(page.locator(".writingActions select")).toHaveCSS("font-size", "16px");
      await expect(page.locator(".writingCodeEditor .cm-content")).toHaveCSS("font-size", "16px");
      await expect(page.locator(".writingActions .writingButton").first()).toHaveCSS("font-size", "13px");
      await expect(page.locator(".writingHeading > span").first()).toHaveCSS("font-size", "13px");
    }
    assert.ok(await workbench.evaluate(element => element.getBoundingClientRect().width <= innerWidth));
    await expect(page.locator(".writingActions select")).toBeInViewport();
    await page.screenshot({ path: `${screenshots}/mobile-${theme}-tex.png` });
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.locator(".writingFiles")).toHaveCSS("opacity", "1");
    await settle();
    await page.screenshot({ path: `${screenshots}/mobile-${theme}-files.png` });
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await settle();
  }
  await page.setViewportSize({ width: 360, height: 780 });
  await settle();
  await assertHeaderLayout();
  await page.screenshot({ path: `${screenshots}/mobile-compact-tex.png` });
  await page.setViewportSize({ width: 1560, height: 960 });
  await page.getByRole("treeitem", { name: /word-fixture\.docx/ }).click();
  const wordText = page.locator(".writingDocxEditor .superdoc-page").getByText("Keep this cell", { exact: true }).first();
  await expect(wordText).toBeVisible({ timeout: 90000 });
  const paperFontSize = await wordText.evaluate(element => getComputedStyle(element).fontSize);
  console.log(JSON.stringify({ phase: "word", paperFontSize }));
  if (!inspect) assert.equal(paperFontSize, "14.6667px", "Word document point sizes are not changed by UI typography");
  await settle();
  await page.screenshot({ path: `${screenshots}/desktop-word.png` });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: inspect ? "INSPECTED" : "PASS", url, screenshots, readonly: true }));
} finally { await browser.close(); }
