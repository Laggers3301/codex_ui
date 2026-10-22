import assert from "node:assert/strict";
import { chromium, firefox } from "@playwright/test";

const origin = process.env.COMPOSER_TEST_ORIGIN ?? "http://127.0.0.1:5212";
const engines = (process.env.COMPOSER_TEST_BROWSERS ?? "chromium").split(",");
for (const name of engines) {
  const type = { chromium, firefox }[name];
  assert.ok(type, "Unknown test browser: " + name);
  const executablePath = name === "firefox" ? process.env.COMPOSER_FIREFOX_BIN : undefined;
  const browser = await type.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(origin + "/tests/composerIme.browser.html");
    await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.editor);
    const report = await page.evaluate(() => window.runComposerImeCases());
    assert.deepEqual(errors, []);
    assert.equal(report.results.length, 11);
    console.log(JSON.stringify({ browser: name, ...report }));
  } finally { await browser.close(); }
}
