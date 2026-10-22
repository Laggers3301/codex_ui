import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const evidence = new URL("../../data/backend/ambient-glow-20261021/voice/", import.meta.url).pathname;
await fs.mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.QA_CHROMIUM_PATH ? { executablePath: process.env.QA_CHROMIUM_PATH } : {}),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
const results = [], errors = [];
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 393, height: 780 } : { width: 1000, height: 900 }, permissions: ["microphone"] });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    // Deterministic loudness only: production MediaRecorder, analyser lifecycle and
    // microphone permission are real browser APIs; recognition is explicitly mocked.
    await page.addInitScript(() => {
      window.__voiceQA = { amplitude: 0, contexts: [], streams: [], reads: 0 };
      const NativeContext = window.AudioContext;
      window.AudioContext = class extends NativeContext {
        constructor(...args) { super(...args); window.__voiceQA.contexts.push(this); }
      };
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints); window.__voiceQA.streams.push(stream); return stream;
      };
      AnalyserNode.prototype.getFloatTimeDomainData = function (array) {
        array.fill(window.__voiceQA.amplitude); window.__voiceQA.reads++;
      };
    });
    let speechRequests = 0;
    await page.route("**/api/speech/**", async route => {
      speechRequests++;
      const url = route.request().url();
      const result = url.endsWith("/uploads") ? { id: "isolated-voice-qa", combinedTail: true }
        : url.endsWith("/complete") || url.endsWith("/transcribe") ? { text: "语音识别测试草稿", model: "mock-no-inference" } : {};
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) });
    });
    await page.goto("http://127.0.0.1:4187/tests/ambientGlow.browser.html", { waitUntil: "networkidle" });
    const layer = page.locator(".composerAmbientGlow");
    const input = page.getByRole("textbox", { name: "测试输入" });
    for (const theme of ["dark", "light"]) {
      if (theme === "light") await page.getByRole("button", { name: "切换白天／黑夜" }).click();
      await input.fill("");
      const layout = await page.locator(".composer").boundingBox();
      await page.getByRole("button", { name: "语音输入", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".composerAmbientGlow")?.dataset.recording === "true");
      await page.waitForTimeout(850);
      assert.equal(await layer.getAttribute("data-active"), "true");
      const quiet = await layer.evaluate(element => Number(element.style.getPropertyValue("--ambient-voice-y")));
      assert.equal(quiet, 1);
      await page.screenshot({ path: `${evidence}/${mobile ? "mobile" : "desktop"}-${theme}-quiet.png`, fullPage: true });
      await page.evaluate(() => { window.__voiceQA.amplitude = .2; });
      await page.waitForTimeout(1000);
      const loud = await layer.evaluate(element => Number(element.style.getPropertyValue("--ambient-voice-y")));
      assert.ok(loud > 1.17 && loud <= 1.19);
      const envelope = await layer.evaluate(element => ({ ratio: element.getBoundingClientRect().height / element.parentElement.getBoundingClientRect().height, overflow: getComputedStyle(element).overflow }));
      assert.ok(Math.abs(envelope.ratio - .4) < .002, "loud speech must stay within 40% of conversation height");
      assert.equal(envelope.overflow, "hidden");
      const after = await page.locator(".composer").boundingBox();
      assert.equal(after.width, layout.width); assert.equal(after.height, layout.height);
      assert.equal(after.x, layout.x);
      assert.ok(Math.abs(after.y - layout.y) <= 1, "allow only the existing 1px composer hover, never audio-driven layout shifts");
      await page.screenshot({ path: `${evidence}/${mobile ? "mobile" : "desktop"}-${theme}-loud.png`, fullPage: true });
      await page.evaluate(() => { window.__voiceQA.amplitude = 0; });
      await page.waitForTimeout(900);
      const softer = await layer.evaluate(element => Number(element.style.getPropertyValue("--ambient-voice-y")));
      assert.ok(softer > 1 && softer < 1.04);
      await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
      await page.waitForTimeout(1250);
      assert.equal(await layer.getAttribute("data-recording"), "false");
      assert.equal(await layer.getAttribute("data-active"), "false");
      assert.ok(await page.evaluate(() => window.__voiceQA.contexts.every(context => context.state === "closed") && window.__voiceQA.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended"))));
      results.push({ mobile, theme, quiet, loud, softer, cancelledAndReleased: true });
    }
    // Cancel -> re-record -> stop/transcribe: no stuck recorder, glow returns with text.
    await page.getByRole("button", { name: "语音输入", exact: true }).click();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "结束录音并转成文字", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("textarea")?.value.includes("语音识别测试草稿"));
    assert.equal(await layer.getAttribute("data-active"), "true");
    assert.equal(await layer.getAttribute("data-recording"), "false");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "语音输入", exact: true }).click();
    await page.evaluate(() => { window.__voiceQA.amplitude = .2; });
    await page.waitForTimeout(700);
    assert.equal(await page.locator(".composerAmbientGlowField").evaluate(element => getComputedStyle(element).transform), "none");
    await page.getByRole("button", { name: "取消语音输入", exact: true }).click();
    assert.equal(await layer.getAttribute("data-active"), "true", "existing draft persists after cancellation");
    results.push({ mobile, rerecordAndMockTranscription: true, reducedMotion: true, speechRequestsIntercepted: speechRequests });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, errors, physicalIphoneTested: false }, null, 2));
  await fs.writeFile(`${evidence}/results.json`, JSON.stringify({ results, errors, physicalIphoneTested: false }, null, 2));
} finally { await browser.close(); }
