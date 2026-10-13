import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const frontend = resolve(import.meta.dirname, "..");
const workspace = resolve(frontend, "..");
const baseURL = "http://127.0.0.1:5174";
const uiDir = resolve(workspace, "output/pets/20261003-nailong-v2/qa/ui");
const petDir = resolve(workspace, "output/pets/20261003-nailong-v2");
await mkdir(uiDir, { recursive: true });

const vite = spawn(process.execPath, [resolve(frontend, "node_modules/vite/bin/vite.js"), "--config", "tests/threadActivity.vite.config.mjs"], {
  cwd: frontend,
  stdio: "ignore",
  env: { ...process.env, VITE_DISABLE_HMR: "1" }
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { ready = (await fetch(`${baseURL}/tests/petBuddy.browser.html`)).ok; } catch { /* isolated server is still starting */ }
    if (ready) break;
    if (vite.exitCode !== null) throw new Error(`Vite exited early (${vite.exitCode})`);
    await delay(250);
  }
  assert(ready, "isolated Vite test server did not start");

  browser = await chromium.launch({ headless: true });
  const atlasBytes = await readFile(resolve(petDir, "final/spritesheet.png"));
  const laughBytes = await readFile(resolve(petDir, "final/laugh-strip.png"));
  assert.equal(atlasBytes.readUInt32BE(16), 1536);
  assert.equal(atlasBytes.readUInt32BE(20), 2288);
  assert.equal(laughBytes.readUInt32BE(16), 1536);
  assert.equal(laughBytes.readUInt32BE(20), 208);

  const mockServer = () => ({
    pets: [{ id: "qa-nailong-v2", name: "奶龙·临时验收", version: 2, format: "png", spritesheetUrl: "/api/pets/qa/spritesheet", laughSpritesheetUrl: "/api/pets/qa/laugh" }],
    prefs: { activePetId: null, visible: false, position: null },
    patches: [], uploads: 0,
    laughRequests: 0,
    failNextPatch: false,
    uploadedFormHadVersion: null
  });
  const attachMocks = async (context, mock) => {
    await context.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/pets" && request.method() === "GET") {
        await route.fulfill({ json: { pets: mock.pets, ...mock.prefs, prefs: mock.prefs } }); return;
      }
      if (url.pathname === "/api/pets" && request.method() === "POST") {
        const body = request.postDataBuffer()?.toString("latin1") ?? "";
        mock.uploadedFormHadVersion = /Content-Disposition: form-data; name="version"/i.test(body);
        mock.uploads += 1;
        const pet = { id: `qa-upload-${mock.uploads}`, name: "上传图集·临时", version: 2, format: "png", spritesheetUrl: "/api/pets/qa/spritesheet", laughSpritesheetUrl: "/api/pets/qa/laugh" };
        mock.pets.push(pet);
        await route.fulfill({ json: { pet } }); return;
      }
      if (url.pathname === "/api/pets/prefs" && request.method() === "PATCH") {
        const change = request.postDataJSON(); mock.patches.push(change);
        if (mock.failNextPatch) { mock.failNextPatch = false; await route.fulfill({ status: 503, json: { error: "QA preference save failure" } }); return; }
        Object.assign(mock.prefs, change);
        // Deliberately match the real PATCH response: preferences only, no pets list.
        await route.fulfill({ json: { prefs: { ...mock.prefs } } }); return;
      }
      if (url.pathname === "/api/pets/qa/spritesheet") {
        await route.fulfill({ status: 200, contentType: "image/png", body: atlasBytes, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } }); return;
      }
      if (url.pathname === "/api/pets/qa/laugh") {
        mock.laughRequests += 1;
        await route.fulfill({ status: 200, contentType: "image/png", body: laughBytes, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } }); return;
      }
      await route.fulfill({ status: 404, json: { error: "Unmocked QA API endpoint" } });
    });
  };
  const shot = async (page, filename) => page.screenshot({ path: resolve(uiDir, filename), animations: "allow" });

  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 850 }, colorScheme: "dark" });
  const desktopMock = mockServer(); await attachMocks(desktopContext, desktopMock);
  const desktop = await desktopContext.newPage();
  const pageErrors = [];
  desktop.on("pageerror", (error) => pageErrors.push(error.message));
  await desktop.goto(`${baseURL}/tests/petBuddy.browser.html`);
  await desktop.waitForFunction(() => document.querySelector(".qaPetTrigger"));
  await desktop.waitForFunction(() => document.querySelector(".qaShell"));
  await delay(120);
  assert.equal(await desktop.locator(".petBuddyFloat").count(), 0, "pet should start hidden");
  await shot(desktop, "desktop-dark-default-hidden.png");

  const trigger = desktop.locator(".qaPetTrigger");
  await trigger.click();
  const dialog = desktop.getByRole("dialog", { name: "选择宠物" });
  await dialog.waitFor({ state: "visible" });
  await desktop.waitForFunction(() => document.activeElement?.getAttribute("placeholder") === "搜索宠物");
  for (const selector of ["header strong", "header small", ".petSearch input", ".petChoice span", ".petUpload", ".petEmpty"]) {
    assert.equal(await dialog.locator(selector).first().evaluate(element => getComputedStyle(element).fontSize), "14px", `desktop picker uses one 14px type scale: ${selector}`);
  }
  await shot(desktop, "desktop-dark-picker.png");
  await desktop.keyboard.press("Escape");
  await desktop.locator(".petPickerScrim").waitFor({ state: "detached" });
  assert.equal(await desktop.evaluate(() => document.activeElement?.classList.contains("qaPetTrigger")), true, "Escape should restore focus");

  await trigger.click();
  await dialog.waitFor({ state: "visible" });
  await desktop.locator('.petUpload input[type="file"]').setInputFiles(resolve(petDir, "final/spritesheet.png"));
  await desktop.getByRole("button", { name: /上传图集·临时/ }).waitFor({ state: "visible" });
  assert.equal(desktopMock.uploadedFormHadVersion, false, "upload must let the server infer the atlas version");
  assert.equal(desktopMock.pets.length, 2, "mock upload should add a temporary in-memory choice");
  await desktop.getByRole("button", { name: /奶龙·临时验收/ }).click();
  assert.equal(desktopMock.prefs.activePetId, "qa-nailong-v2");
  assert.equal(desktopMock.prefs.visible, false, "selection must not enable visibility");
  assert.equal(await desktop.locator(".petBuddyFloat").count(), 0);
  assert.equal(await dialog.locator(".petChoice").count(), 2, "prefs-only response must not lose pet records");
  await desktop.getByRole("button", { name: "显示宠物" }).click();
  await desktop.locator(".petBuddyFloat canvas").waitFor({ state: "visible" });
  await desktop.waitForFunction(() => {
    const canvas = document.querySelector(".petBuddyFloat canvas");
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  });
  await desktop.locator(".petPickerScrim").waitFor({ state: "detached" });
  await delay(760);
  assert.equal(desktopMock.prefs.visible, true);
  await shot(desktop, "desktop-dark-visible-v2-fixture.png");

  const float = desktop.locator(".petBuddyFloat");
  let box = await float.boundingBox();
  const composer = desktop.locator(".qaComposer");
  const composerBox = await composer.boundingBox();
  await desktop.mouse.move(box.x + 40, box.y + 45);
  await desktop.mouse.down();
  await desktop.mouse.move(1278, 840, { steps: 6 });
  await desktop.mouse.up();
  await delay(120);
  box = await float.boundingBox();
  assert(box.x + box.width <= 1280.5, `drag clamp right edge: ${JSON.stringify(box)}`);
  assert(box.y + box.height <= composerBox.y + 0.5, `pet should not cover composer: ${JSON.stringify({ box, composerBox })}`);
  assert.equal(desktopMock.laughRequests, 0, "dragging should not trigger laugh");
  await shot(desktop, "desktop-dark-drag-clamped.png");

  await desktop.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await desktop.waitForFunction(() => document.querySelector(".petBuddyFloat canvas") !== null);
  for (let attempt = 0; attempt < 30 && desktopMock.laughRequests === 0; attempt += 1) await delay(50);
  assert(desktopMock.laughRequests > 0, "tap should lazy-load the optional laugh strip");
  await delay(160);
  await shot(desktop, "desktop-dark-tap-laugh.png");

  desktopMock.failNextPatch = true;
  await float.getByRole("button", { name: "隐藏宠物" }).click();
  await desktop.waitForFunction(() => {
    const element = document.querySelector(".petBuddyFloat");
    return Boolean(element && !element.classList.contains("closing"));
  });
  assert.equal(desktopMock.prefs.visible, true, "failed save should leave server visibility unchanged");
  assert.equal(await float.count(), 1, "failed save should roll back optimistic visibility");
  await trigger.click(); await dialog.waitFor({ state: "visible" });
  await desktop.getByRole("alert").waitFor({ state: "visible" });
  await desktop.getByRole("button", { name: "关闭" }).click();
  await desktop.locator(".petPickerScrim").waitFor({ state: "detached" });
  await float.getByRole("button", { name: "隐藏宠物" }).click();
  await float.waitFor({ state: "attached" });
  await desktop.waitForFunction(() => document.querySelector(".petBuddyFloat")?.classList.contains("closing"));
  await delay(90);
  const exitOpacity = await float.evaluate((element) => Number(getComputedStyle(element).opacity));
  assert(exitOpacity > 0 && exitOpacity < 1, `exit animation should expose a genuine middle frame (opacity ${exitOpacity})`);
  await shot(desktop, "desktop-dark-hide-exit-middle.png");
  await float.waitFor({ state: "detached" });
  assert.equal(desktopMock.prefs.visible, false);

  await desktop.emulateMedia({ reducedMotion: "reduce" });
  await desktop.evaluate(() => {
    const prototype = CanvasRenderingContext2D.prototype;
    const original = prototype.drawImage;
    window.__qaDrawCount = 0;
    window.__qaOriginalDraw = original;
    prototype.drawImage = function (...args) {
      window.__qaDrawCount += 1;
      return original.apply(this, args);
    };
  });
  await trigger.click();
  await dialog.waitFor({ state: "visible" });
  await desktop.getByRole("button", { name: "显示宠物" }).click();
  await desktop.locator(".petBuddyFloat canvas").waitFor({ state: "visible" });
  await delay(250);
  const reducedDraws = await desktop.evaluate(() => window.__qaDrawCount ?? 0);
  await delay(400);
  assert.equal(await desktop.evaluate(() => window.__qaDrawCount ?? 0), reducedDraws, "reduced motion should render a static frame, not animate canvas");
  assert.equal(await desktop.locator(".petPickerScrim").count(), 0);

  await desktop.emulateMedia({ reducedMotion: "no-preference" });
  await desktop.evaluate(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Set();
    window.__qaPendingRaf = pending;
    window.requestAnimationFrame = ((callback) => {
      let id = 0;
      id = raf((time) => { pending.delete(id); callback(time); }); pending.add(id); return id;
    });
    window.cancelAnimationFrame = ((id) => { pending.delete(id); cancel(id); });
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    window.__qaSetHidden = (next) => { hidden = next; document.dispatchEvent(new Event("visibilitychange")); };
  });
  await desktop.locator(".petPickerScrim").waitFor({ state: "detached" });
  await desktop.locator(".petBuddyFloat").evaluate((element) => new Promise((resolve) => element.addEventListener("animationend", (event) => { if (event.animationName === "petFloatIn") resolve(); }, { once: true })));
  await desktop.waitForFunction(() => window.__qaPendingRaf?.size === 1);
  await desktop.evaluate(() => window.__qaSetHidden?.(true));
  await delay(80);
  assert.equal(await desktop.evaluate(() => window.__qaPendingRaf?.size), 0, "hidden tab must cancel, not reschedule, RAF");
  await desktop.evaluate(() => window.__qaSetHidden?.(false));
  await desktop.waitForFunction(() => window.__qaPendingRaf?.size === 1);
  await desktop.evaluate(() => window.__qaSetHidden?.(true));
  await desktop.emulateMedia({ colorScheme: "light" });
  await desktop.locator(".qaThemeToggle").click();
  await shot(desktop, "desktop-light-visible-v2-fixture.png");

  assert.deepEqual(pageErrors, [], `desktop browser runtime errors: ${pageErrors.join(" | ")}`);
  await desktopContext.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" });
  const mobileMock = mockServer(); await attachMocks(mobileContext, mobileMock);
  const mobile = await mobileContext.newPage();
  await mobile.goto(`${baseURL}/tests/petBuddy.browser.html`);
  await mobile.waitForFunction(() => document.querySelector(".qaPetTrigger"));
  await mobile.locator(".qaThemeToggle").click();
  await shot(mobile, "mobile-light-default-hidden.png");
  await mobile.locator(".qaPetTrigger").click();
  const mobileDialog = mobile.getByRole("dialog", { name: "选择宠物" }); await mobileDialog.waitFor({ state: "visible" });
  assert.equal(await mobile.locator(".petSearch input").evaluate((element) => getComputedStyle(element).fontSize), "16px");
  assert.equal(await mobile.locator(".petSearch input").evaluate(element => {
    const style = getComputedStyle(element);
    return parseFloat(style.fontSize) * new DOMMatrix(style.transform).a;
  }), 14, "mobile input remains 16px for iOS but visually matches the 14px picker");
  await mobile.waitForTimeout(450);
  await shot(mobile, "mobile-light-picker.png");
  await mobile.getByRole("button", { name: /奶龙·临时验收/ }).click();
  assert.equal(mobileMock.prefs.visible, false);
  await mobile.getByRole("button", { name: "显示宠物" }).click();
  const mobileFloat = mobile.locator(".petBuddyFloat"); await mobileFloat.waitFor({ state: "visible" });
  await mobile.waitForFunction(() => {
    const canvas = document.querySelector(".petBuddyFloat canvas");
    const pixels = canvas?.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return false;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return true;
    return false;
  });
  await mobile.locator(".petPickerScrim").waitFor({ state: "detached" });
  await delay(760);
  await shot(mobile, "mobile-light-visible-v2-fixture.png");
  const mobileBox = await mobileFloat.boundingBox();
  await mobile.touchscreen.tap(mobileBox.x + mobileBox.width / 2, mobileBox.y + mobileBox.height / 2);
  for (let attempt = 0; attempt < 30 && mobileMock.laughRequests === 0; attempt += 1) await delay(50);
  assert(mobileMock.laughRequests > 0, "mobile tap should play laugh");
  const mobileComposerBox = await mobile.locator(".qaComposer").boundingBox();
  await mobile.mouse.move(mobileBox.x + 40, mobileBox.y + 40); await mobile.mouse.down(); await mobile.mouse.move(389, 835, { steps: 5 }); await mobile.mouse.up(); await delay(100);
  const movedMobileBox = await mobileFloat.boundingBox();
  assert(movedMobileBox.x + movedMobileBox.width <= 390.5);
  assert(movedMobileBox.y + movedMobileBox.height <= mobileComposerBox.y + 0.5, "mobile pet must remain above the composer");
  await shot(mobile, "mobile-light-drag-clamped.png");
  await mobile.locator(".qaPetTrigger").click(); await mobileDialog.waitFor({ state: "visible" });
  await mobile.locator(".petVisibilityToggle").click();
  await mobileFloat.waitFor({ state: "detached" });
  assert.equal(mobileMock.prefs.visible, false);
  await mobileContext.close();

  console.log(JSON.stringify({
    result: "passed",
    assertions: ["default-hidden", "picker-search/Escape/focus restore", "temporary upload/no explicit version", "prefs-only response preserves pet list", "v2 atlas render", "desktop pointer drag clamp/no accidental laugh", "desktop and mobile tap-to-laugh lazy-load", "failed PATCH rollback/recovery", "hide exit middle-frame", "reduced-motion static canvas", "document-hidden RAF cancellation", "mobile input size/composer clearance", "dark and light themes"],
    mockApiOnly: true,
    fixture: "unmodified final v2 spritesheet and laugh-strip bytes served by in-memory API mocks; no pet was persisted",
    screenshots: uiDir
  }, null, 2));
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
