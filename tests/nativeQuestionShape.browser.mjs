import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const output = new URL("../../data/backend/ambient-glow-20261021/", import.meta.url).pathname;
const browser = await chromium.launch({ ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const results = [];
try {
  for (const theme of ["dark", "light"]) {
    const context = await browser.newContext({ viewport: { width: 393, height: 780 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/api/**", route => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.goto("http://127.0.0.1:4187/tests/questionTool.browser.html?native");
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.body.style.minWidth = "0"; }, theme);
    await page.locator(".toolQuestionCard").waitFor();
    assert.equal(await page.getByRole("button", { name: /允许独立浏览器验收/ }).count(), 1);
    assert.equal(await page.locator("pre").count(), 0, "native arguments/accepted receipt are not printed as raw JSON");
    await page.getByRole("textbox").fill("先测试，然后给我预览");
    await page.screenshot({ path: `${output}/question-native-${theme}.png` });
    await page.getByRole("button", { name: "发送自定义答案" }).click();
    await page.locator(".toolQuestionCard").waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("answer").textContent(), "先测试，然后给我预览");
    assert.deepEqual(errors, []);
    results.push({ theme, choices: true, customAnswer: true, disappearsAfterSubmission: true, rawJson: false, errors });
    await context.close();
  }
  await fs.writeFile(`${output}/question-results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally { await browser.close(); }
