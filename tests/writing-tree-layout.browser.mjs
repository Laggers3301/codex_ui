// Read-only production check: inspect an owned workspace and resize its UI.
// No model turns, file opens/edits, compiler jobs or conversation mutations.
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const username = process.env.DOCUMENT_QA_USER || "qaUser";
const url = process.env.DOCUMENT_QA_URL || "http://127.0.0.1:4575";
const root = process.env.DOCUMENT_QA_ROOT || process.cwd();
const inspect = process.env.WRITING_TREE_INSPECT === "1";
if (!process.env.DOCUMENT_QA_PASSWORD) throw new Error("Authorized QA login required.");
const screenshots = await fs.mkdtemp("/tmp/codex-writing-tree-");
const browser = await chromium.launch({ executablePath: process.env.DOCUMENT_QA_CHROMIUM || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1560, height: 960 }, reducedMotion: "no-preference" });
  const login = await context.request.post(`${url}/api/auth/login`, { data: { username, password: process.env.DOCUMENT_QA_PASSWORD } });
  assert.ok(login.ok());
  const projects = await context.request.get(`${url}/api/projects`, { headers: { "x-codex-web-user-id": username } });
  assert.ok(projects.ok());
  const project = (await projects.json()).data.find(candidate => candidate.rootPath === root);
  assert.ok(project, "an existing owned workspace is required");
  await context.addInitScript(username => { localStorage.setItem("codex-web-user-id", username); localStorage.setItem("codex-web-color-theme", "light"); localStorage.setItem("codex-web-thread-list-collapsed", "false"); }, username);
  const page = await context.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const settle = () => page.evaluate(async () => {
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
  const measure = () => page.locator(".writingTreeEntry[role=treeitem]").evaluateAll(rows => rows.map(row => {
    const icon = row.querySelector(".writingIcon");
    const name = row.querySelector("span:not(.writingIcon)");
    const size = row.querySelector("small");
    const box = row.getBoundingClientRect(), iconBox = icon.getBoundingClientRect(), nameBox = name.getBoundingClientRect();
    const style = getComputedStyle(row);
    const sizeWidth = size?.getBoundingClientRect().width ?? 0;
    const expectedWidth = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - iconBox.width - sizeWidth - parseFloat(style.columnGap) * (size ? 2 : 1);
    return { name: name.textContent, rowWidth: box.width, iconWidth: iconBox.width, gap: nameBox.left - iconBox.right, nameWidth: nameBox.width, expectedWidth, truncated: name.scrollWidth > name.clientWidth, title: row.title };
  }));
  const check = async label => {
    const rows = await measure();
    assert.ok(rows.length);
    const metrics = { rows: rows.length, iconWidth: Math.max(...rows.map(row => row.iconWidth)), gap: Math.max(...rows.map(row => row.gap)), nameWidth: rows[0].nameWidth, rowWidth: rows[0].rowWidth, truncated: rows.filter(row => row.truncated).length };
    console.log(JSON.stringify({ phase: label, ...metrics }));
    if (!inspect) for (const row of rows) {
      assert.ok(row.iconWidth <= 16, "icons must not absorb filename space");
      assert.ok(row.gap >= 0 && row.gap <= 5.1, "icon-to-name gap stays 5px");
      assert.ok(Math.abs(row.nameWidth - row.expectedWidth) <= 1, "names use all remaining row width");
      assert.ok(row.title.endsWith(row.name), "full names remain available in the existing hover title");
    }
    return rows;
  };
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(`.v2WorkspaceGroup[data-project-id="${project.id}"] .projectNewThreadButton`).click();
  const collapse = page.getByRole("button", { name: "折叠侧边栏", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await page.locator(".v2ComposerPlus").click();
  await page.locator('#v2PlusMenu [data-action="writing"]').click();
  await expect(page.locator(".writingTreeEntry[role=treeitem]").first()).toBeVisible();
  await settle();
  const narrow = await check("desktop-default");
  await page.screenshot({ path: `${screenshots}/desktop-light-default.png` });
  const handle = await page.getByRole("separator", { name: "调整文件栏宽度", exact: true }).boundingBox();
  assert.ok(handle);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 160, handle.y + handle.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.locator(".writingFiles").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(365);
  await settle();
  const wide = await check("desktop-widened");
  if (!inspect) {
    assert.ok(Math.abs(wide[0].iconWidth - narrow[0].iconWidth) < .1, "resizing never widens the icon");
    assert.ok(Math.abs((wide[0].nameWidth - narrow[0].nameWidth) - (wide[0].rowWidth - narrow[0].rowWidth)) <= 1, "the entire extra width goes to filenames");
    assert.ok(wide.filter(row => row.truncated).length <= narrow.filter(row => row.truncated).length, "widening cannot hide more names");
  }
  await page.locator(".writingTree").evaluate(tree => {
    const files = [...tree.querySelectorAll('[role="treeitem"]')].filter(row => row.querySelector("small"));
    const example = files.find(row => /compose_/.test(row.textContent)) || files.find(row => row.querySelector("span:not(.writingIcon)").textContent.length > 24) || files[0];
    example?.scrollIntoView({ block: "center" });
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.setViewportSize({ width: 1560, height: 960 });
    await settle();
    await check(`desktop-${theme}`);
    await page.screenshot({ path: `${screenshots}/desktop-${theme}-wide.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await expect(page.locator(".writingFiles")).toHaveCSS("opacity", "1");
    await settle();
    await check(`mobile-${theme}`);
    assert.ok(await page.locator(".writingTree").evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: `${screenshots}/mobile-${theme}-files.png` });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: inspect ? "INSPECTED" : "PASS", url, screenshots, readonly: true }));
} finally { await browser.close(); }
