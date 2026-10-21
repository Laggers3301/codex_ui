import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const evidence = new URL("../../data/backend/transfer-receipt-20261021/", import.meta.url).pathname;
await fs.mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = [], results = [];
try {
  for (const mobile of [false, true]) {
    const page = await browser.newPage({ viewport: mobile ? { width: 393, height: 780 } : { width: 1000, height: 780 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://127.0.0.1:4187/tests/transferReceipt.browser.html", { waitUntil: "networkidle" });
    if (mobile) await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await page.getByRole("button", { name: "模拟发送成功", exact: true }).click();
    const receipt = page.locator(".transientTransferReceipt");
    assert.equal(await receipt.count(), 1);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${evidence}/${mobile ? "mobile-light" : "desktop-dark"}-visible.png`, fullPage: true });
    const initialY = (await page.getByTestId("next-answer").boundingBox()).y;
    await page.getByRole("button", { name: "重绘", exact: false }).click();
    await page.waitForFunction(() => document.querySelector(".transientTransferReceipt.closing"));
    assert.equal(await receipt.getAttribute("aria-hidden"), "true");
    await page.waitForFunction(() => !document.querySelector(".transientTransferReceipt"));
    const finalY = (await page.getByTestId("next-answer").boundingBox()).y;
    assert.ok(finalY < initialY, "the receipt must release its layout space");
    assert.equal(await page.getByTestId("failed-receipt").count(), 1);
    assert.ok((await page.getByTestId("next-answer").textContent()).includes("不会被删除"));
    await page.screenshot({ path: `${evidence}/${mobile ? "mobile-light" : "desktop-dark"}-removed.png`, fullPage: true });
    // Hidden receipts must not reappear or restart their lifetime on navigation.
    await page.getByRole("button", { name: "模拟发送成功", exact: true }).click();
    await page.getByRole("button", { name: "切换会话", exact: true }).click();
    await page.waitForTimeout(6500);
    await page.getByRole("button", { name: "切换会话", exact: true }).click();
    assert.equal(await receipt.count(), 0);
    results.push({ mobile, expiresAndCollapses: true, failedReceiptAndAnswerPreserved: true, noRevivalAfterNavigation: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(`${evidence}/results.json`, JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally { await browser.close(); }
