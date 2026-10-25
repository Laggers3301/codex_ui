import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const origin = process.env.MOTION_TEST_ORIGIN ?? "http://127.0.0.1:5216";
const evidence = process.env.MOTION_TEST_EVIDENCE ?? "../data/backend/tool-motion-20261024";
await fs.mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [], results = [];
try {
  for (const theme of ["dark", "light"]) for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 393, height: 852 } : { width: 1200, height: 900 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/tests/toolActivityMotion.browser.html");
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    assert.equal(await page.locator(".toolRollingCountNew").innerText(), "1");
    assert.equal(await page.locator(".toolBundleEntries").evaluate(node => node.getAnimations({ subtree: true }).length), 0, "history never replays on mount");
    await page.getByText("批量收到16条", { exact: true }).click();
    const delays = await page.locator(".toolBundleEntries").evaluate(node => node.getAnimations({ subtree: true }).map(animation => animation.effect.getTiming().delay));
    assert.ok(delays.length > 0 && Math.max(...delays) <= 160);
    assert.ok(new Set(delays).size > 1, "burst rows are staggered, not one abrupt batch");
    await page.waitForFunction(() => document.querySelector(".toolRollingCountNew")?.textContent === "17");
    await page.getByText("大量工具", { exact: true }).click();
    await page.getByText(/正文刷新/).click();
    await page.waitForFunction(() => document.querySelector(".toolRollingCountNew")?.textContent === "10000");
    assert.equal(await page.locator(".toolRollingCount").getAttribute("aria-label"), "10000");
    await page.waitForTimeout(220);
    await page.screenshot({ path: `${evidence}/${theme}-${mobile ? "mobile" : "desktop"}.png` });
    await page.getByText("切换历史", { exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".toolRollingCountNew")?.textContent === "1");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByText("批量收到16条", { exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".toolRollingCountNew")?.textContent === "17");
    assert.equal(await page.locator(".toolBundleEntries").evaluate(node => node.getAnimations({ subtree: true }).length), 0);
    results.push({ theme, mobile, staggered: true, finalCount: true, reducedMotion: true, noHistoryReplay: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(`${evidence}/results.json`, JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }));
} finally { await browser.close(); }
