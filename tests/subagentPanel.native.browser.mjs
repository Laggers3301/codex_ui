import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const appRoot = process.env.SUBAGENT_NATIVE_QA_APP_ROOT || process.cwd();
const username = process.env.DOCUMENT_QA_USER || "qaUser";
const parentId = process.env.SUBAGENT_NATIVE_QA_THREAD;
assert.ok(parentId, "Set SUBAGENT_NATIVE_QA_THREAD to an owned QA thread");
const production = process.env.SUBAGENT_NATIVE_QA_PRODUCTION === "1";
const baseline = process.env.SUBAGENT_POLISH_BASELINE === "1";
const origin = process.env.SUBAGENT_NATIVE_QA_ORIGIN ?? (production ? "http://127.0.0.1:4575" : "http://127.0.0.1:4590");
const password = process.env.SUBAGENT_QA_PASSWORD;
const signedSession = process.env.SUBAGENT_QA_SESSION;
assert.ok(password || signedSession, "Supply this user's portal password or a short-lived signed session for QA");
const screenshots = await fs.mkdtemp("/tmp/codex-subagent-native-");
let injected, store, project;
const db = new DatabaseSync(process.env.SUBAGENT_NATIVE_QA_DB || `${appRoot}/.codex-web/codex-web.sqlite`, { readOnly: true });
const owner = db.prepare("SELECT project_id, user_id FROM thread_owners WHERE thread_id = ?").get(parentId);
assert.ok(owner, "Owned QA thread not found");
assert.equal(owner.user_id, username);
const actualProject = db.prepare("SELECT root_path FROM projects WHERE id=?").get(owner.project_id);
db.close();
if (!production && process.env.SUBAGENT_NATIVE_ROUTES !== "1") {
  assert.ok(process.env.CODEX_HOME, "Set CODEX_HOME to the authorized QA runtime");
  process.env.CODEX_WEB_ACCOUNT_POOL_FILE ||= `${appRoot}/account-pool.json`;
  process.env.CODEX_WEB_DATA_DIR = screenshots;
  const { default: Fastify } = await import("fastify");
  const { ProjectStore } = await import("../server/db.ts");
  const { registerRoutes } = await import("../server/routes.ts");
  store = new ProjectStore(`${screenshots}/readonly-test.sqlite`);
  // The isolated route harness has no portal auth middleware. Its single
  // owner is the default test identity; the real parent was checked above.
  project = store.createProject({ name: "Readonly parent fixture", rootPath: actualProject.root_path });
  store.registerThreadOwner({ threadId: parentId, userId: "admin", projectId: project.id, rootPath: actualProject.root_path });
  injected = Fastify();
  registerRoutes(injected, { request: () => { throw new Error("Native history QA may not start or resume a model"); } }, store, { backgroundIndexing: false });
}
const browser = await chromium.launch({ executablePath: process.env.DOCUMENT_QA_CHROMIUM || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "no-preference" });
  if (signedSession) {
    await context.addCookies([{ name: "codex_remote_session_4575", value: signedSession, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  } else {
    const login = await context.request.post(`${origin}/api/auth/login`, { data: { username, password } });
    assert.equal(login.status(), 200);
  }
  await context.addInitScript(({ projectId, username }) => {
    localStorage.setItem("codex-web-user-id", username);
    localStorage.setItem("codex-web-color-theme", "dark");
    localStorage.setItem(`codex-v2-project-${username}`, projectId);
    localStorage.setItem(`codex-v2-expanded-projects-${username}`, JSON.stringify([projectId]));
  }, { projectId: owner.project_id, username });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let olderParentRequests = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith(`/threads/${parentId}`) && (url.searchParams.has("cursor") || url.searchParams.has("before"))) olderParentRequests++;
  });
  if (injected) await page.route("**/api/projects/*/threads/*/subagents**", async route => {
    const request = route.request();
    assert.equal(request.method(), "GET");
    const url = new URL(request.url());
    const replaced = url.pathname.replace(`/projects/${owner.project_id}/`, `/projects/${project.id}/`);
    const response = await injected.inject({ method: "GET", url: replaced + url.search, headers: { "x-codex-web-user-id": username } });
    await route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body });
  });
  await page.goto(`${origin}/?thread=${parentId}&project=${owner.project_id}`, { waitUntil: "domcontentloaded" });
  await page.locator(".conversationHeader h2").waitFor({ state: "attached", timeout: 60000 });
  await page.locator(".messages [data-message-key]").first().waitFor({ timeout: 30000 });
  // Directory discovery must not require loading the old dispatch message.
  await page.locator(".subagentActivity .subagentHistoryButton").waitFor({ timeout: 30000 });
  assert.equal(olderParentRequests, 0, "all children appear without fetching older parent history");
  const directoryLabel = await page.locator(".subagentActivity .subagentHistoryButton").innerText();
  const directoryRows = Number(directoryLabel.match(/记录 · (\d+)/)?.[1]);
  assert.ok(directoryRows >= 8, "the global count includes children outside the message window");
  await page.waitForTimeout(500);
  const rail = page.locator(".promptNavigator");
  assert.ok(await rail.evaluate(element => Number(getComputedStyle(element).opacity) > 0 && !element.inert));
  await page.screenshot({ path: `${screenshots}/01-central-dark.png` });
  const sourceThreadTitle = await page.locator(".conversationHeader h2").innerText();
  const draft = page.locator(".conversation > .composer .composerRichInput");
  const draftBefore = await draft.innerText();
  await page.locator(".subagentActivity .subagentHistoryButton").click();
  await page.getByRole('searchbox', { name: '搜索子代理名称或模型' }).fill('subagent_history_backend');
  const row = page.locator(".subagentDirectoryRow").filter({ hasText: "subagent_history_backend" });
  await row.waitFor({ timeout: 30000 });
  const identity = await row.locator(".subagentAvatar").getAttribute("class");
  await page.locator(".messages").first().dispatchEvent("wheel", { deltaY: -1 });
  await row.click();
  await page.locator(".subagentRecord:not(.switching) [data-subagent-item]").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  const hiddenRail = await rail.evaluate(element => ({ opacity: Number(getComputedStyle(element).opacity), visibility: getComputedStyle(element).visibility, transform: getComputedStyle(element).transform, inert: element.inert }));
  assert.equal(hiddenRail.opacity, 0);
  assert.equal(hiddenRail.visibility, "hidden");
  assert.equal(hiddenRail.inert, true);
  const modelBadge = await page.locator(".subagentRecordModel").evaluate(element => ({ background: getComputedStyle(element).backgroundColor, size: getComputedStyle(element).fontSize, text: element.textContent }));
  assert.notEqual(modelBadge.background, "rgba(0, 0, 0, 0)");
  assert.equal(modelBadge.size, "12px");
  assert.equal(await page.locator('.subagentPanelHeader > .subagentRecordModel').count(), 1, 'model badge is in the header, not a separate transcript row');
  const refreshResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname.startsWith(`/api/projects/${owner.project_id}/threads/${parentId}/subagents/`) && /\/subagents\/[^/]+$/.test(new URL(response.url()).pathname));
  await page.getByRole('button', { name: '刷新子代理记录' }).click();
  assert.equal((await refreshResponse).status(), 200, 'manual refresh really reads the selected child from the backend');
  await page.waitForFunction(() => document.querySelector('[aria-label="刷新子代理记录"]').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('.subagentRecord.switching').count(), 0, 'manual refresh does not blank the existing transcript');
  assert.equal(await page.locator(".subagentPanelHeader .subagentAvatar").getAttribute("class"), identity);
  assert.equal(await page.locator(".conversationHeader h2").innerText(), sourceThreadTitle);
  assert.equal(await draft.innerText(), draftBefore);
  const items = await page.locator(".subagentRecord [data-subagent-item]").count();
  assert.ok(items > 1, "real child records include activity clusters and prose, not only its summary");
  const types = await page.locator(".subagentRecord [data-subagent-item]").evaluateAll(rows => ({ bundles: rows.filter(row => row.querySelector(".toolBundle")).length, tools: rows.filter(row => row.querySelector(".toolBundleEntry, .subagentTranscriptTool")).length, reasoning: rows.filter(row => row.querySelector(".reasoningDisclosure")).length, answers: rows.filter(row => row.querySelector(".subagentRecordAnswer")).length }));
  assert.ok(types.bundles > 0 && types.answers > 0);
  const deliveries = page.locator('.subagentRecord .subagentMessageDelivery').filter({ hasText: '主代理' });
  assert.ok(await deliveries.count() > 0, 'real child collaboration messages identify the main agent');
  assert.equal(await deliveries.locator('.subagentState, button').count(), 0, 'delivery never invents a pending task state or links root to a child');
  const deliveryGeometry = await deliveries.locator('.subagentOperation').evaluateAll(rows => rows.map(row => ({ height: row.getBoundingClientRect().height, root: Boolean(row.querySelector('[title="/root"]')) })));
  assert.ok(deliveryGeometry.every(row => row.root && row.height < 29), 'real root deliveries use one compact line');
  const metrics = await page.evaluate(() => {
    const record = document.querySelector(".subagentRecord"), surface = document.querySelector(".rightPaneSubagents");
    return {
      childNodes: record.querySelectorAll("*").length,
      totalNodes: document.querySelectorAll("*").length,
      hiddenReasoningBodies: document.querySelectorAll('.reasoningExpandedShell[aria-hidden="true"] .reasoningExpandedBody').length,
      background: getComputedStyle(surface).backgroundColor,
      mainBackground: getComputedStyle(document.querySelector(".messages")).backgroundColor,
      backdropFilter: getComputedStyle(surface).backdropFilter,
      mountedRows: record.querySelectorAll("[data-subagent-item]").length,
      toolGeometry: [...record.querySelectorAll('.toolBundleEntry')].slice(-1).map(tool => {
        const summary = tool.querySelector('.toolBundleEntrySummary'), meta = tool.querySelector('.messageMeta'), arrow = getComputedStyle(tool, '::after');
        return { toolWidth: tool.getBoundingClientRect().width, recordWidth: record.clientWidth, metaWidth: meta.getBoundingClientRect().width, summaryWidth: summary?.getBoundingClientRect().width, summaryScrollWidth: summary?.scrollWidth, position: getComputedStyle(tool).position, arrowDisplay: arrow.display, arrowRight: arrow.right, arrowVisibility: arrow.visibility };
      }),
      activityGap: [...record.querySelectorAll('.subagentRecordRow.kind-tool')].map(row => Number.parseFloat(getComputedStyle(row).paddingBottom)).filter(gap => gap < 13)
    };
  });
  if (!baseline) {
    assert.equal(metrics.background, metrics.mainBackground, "dark child uses the opaque main-chat background");
    assert.equal(metrics.backdropFilter, "none");
    assert.equal(metrics.hiddenReasoningBodies, 0, "collapsed reasoning is truly lazy in both panes");
    assert.ok(metrics.mountedRows < 80, "native long history has a bounded mounted window");
    assert.ok(metrics.activityGap.every(gap => gap === 4 || gap === 0));
    assert.ok(metrics.toolGeometry.every(tool => tool.metaWidth < tool.toolWidth && tool.toolWidth <= tool.recordWidth), "long command text shrinks inside its column instead of covering the chevron");
    assert.equal(await page.locator(".subagentTranscriptTool").count(), 0);
    assert.ok(await page.locator(".subagentRecord .toolBundleTitleLabel").filter({ hasText: /调用工具 · .* × \d+/ }).count());
    assert.equal(await page.locator(".subagentRecord .toolBundleEntries").count(), 0, "collapsed clusters mount no tool/thought history");
  }
  // Measure actual browser selection painting in the open child pane. Nothing
  // is sent or changed in the transcript; one coalesced action appears afterwards.
  await page.evaluate(() => {
    window.__selectionFrames = [];
    window.__selectionListener = () => {
      const start = performance.now();
      requestAnimationFrame(() => window.__selectionFrames.push(performance.now() - start));
    };
    document.addEventListener("selectionchange", window.__selectionListener);
  });
  const selectionText = page.locator(".subagentRecord .subagentRecordAnswer .messageMarkdown p").first();
  const selectionBox = await selectionText.boundingBox();
  assert.ok(selectionBox);
  await page.mouse.move(selectionBox.x + 3, selectionBox.y + 9);
  await page.mouse.down();
  await page.mouse.move(selectionBox.x + Math.min(270, selectionBox.width - 6), selectionBox.y + 15, { steps: 24 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const selection = await page.evaluate(() => {
    const frames = window.__selectionFrames.slice().sort((a, b) => a - b);
    document.removeEventListener("selectionchange", window.__selectionListener);
    const result = { textLength: getSelection().toString().length, samples: frames.length, medianFrameMs: frames[Math.floor(frames.length / 2)] ?? 0, maxFrameMs: Math.max(0, ...frames) };
    getSelection().removeAllRanges();
    return result;
  });
  assert.ok(selection.samples > 0 && selection.textLength > 0);
  await page.screenshot({ path: `${screenshots}/02-full-record-dark.png` });
  if (!baseline) {
    await page.locator(".subagentRecord").dispatchEvent("wheel", { deltaY: -1 });
    const mainScrollBefore = await page.locator(".messages").first().evaluate(element => element.scrollTop);
    const childBundleKey = await page.locator(".subagentRecord .toolBundle").last().getAttribute("data-message-key");
    assert.ok(childBundleKey);
    const childBundle = page.locator(`.subagentRecord .toolBundle[data-message-key=${JSON.stringify(childBundleKey)}]`);
    const bundleTitle = await childBundle.locator(":scope > .messageMeta").innerText();
    await childBundle.locator(":scope > .messageMeta").click();
    await childBundle.locator(".toolBundleEntry").first().waitFor();
    await page.waitForTimeout(350);
    const childGeometry = await childBundle.locator(".toolBundleEntry").evaluateAll(entries => entries.map(entry => ({ width: entry.getBoundingClientRect().width, metaWidth: entry.querySelector('.messageMeta')?.getBoundingClientRect().width })));
    assert.ok(childGeometry.every(entry => entry.metaWidth < entry.width));
    await page.screenshot({ path: `${screenshots}/02a-cluster-expanded-dark.png` });
    const tool = childBundle.locator(".toolBundleEntry").last();
    await tool.click();
    await tool.locator(".toolBundleInput").waitFor();
    await tool.locator(".outputBlock").waitFor();
    await page.waitForTimeout(450);
    assert.ok(await tool.locator(".outputBlock").innerText());
    assert.ok(Math.abs(await page.locator(".messages").first().evaluate(element => element.scrollTop) - mainScrollBefore) < 2, "opening a child tool never moves the main chat");
    await page.screenshot({ path: `${screenshots}/02b-tool-output-dark.png` });
    await tool.click();
    await page.waitForTimeout(350);
    assert.equal(await childBundle.getAttribute("aria-expanded"), "true");
    // Sample inside the browser's frame loop. A Node/Playwright round-trip can
    // arrive after this 200ms animation has finished on a busy live page.
    const closeAnimation = await childBundle.evaluate(element => new Promise(resolve => {
      const reveal = element.querySelector(':scope > .toolReveal');
      const start = performance.now();
      element.querySelector(':scope > .messageMeta').click();
      const sample = () => {
        const details = { opacity: Number(getComputedStyle(reveal).opacity), ease: getComputedStyle(reveal).transitionTimingFunction, inert: reveal.inert };
        if ((details.inert && details.opacity > 0 && details.opacity < 1) || performance.now() - start > 1800) resolve(details);
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    assert.ok(closeAnimation.opacity > 0 && closeAnimation.opacity < 1 && closeAnimation.inert && closeAnimation.ease.includes("cubic-bezier"), JSON.stringify(closeAnimation));
    await childBundle.locator(".toolBundleEntries").waitFor({ state: "detached" });
    metrics.bundle = { title: bundleTitle, entries: childGeometry.length, closeAnimation };
    assert.ok(Math.abs(await page.locator(".messages").first().evaluate(element => element.scrollTop) - mainScrollBefore) < 2, "opening/closing a child cluster never moves the main chat");
    // Exercise the shared renderer in the main pane too: the old max-content
    // track used to let long summaries escape the entry in either location.
    const mainBundleKey = await page.locator(".messages .toolBundle:not(.live)").first().getAttribute("data-message-key").catch(() => null);
    if (mainBundleKey) {
      const bundle = page.locator(`.messages .toolBundle[data-message-key=${JSON.stringify(mainBundleKey)}]`);
      const wasOpen = await bundle.getAttribute("class").then(value => value.includes("toolExpanded"));
      if (!wasOpen) await bundle.locator(":scope > .messageMeta").click();
      await bundle.locator(".toolBundleEntry").first().waitFor();
      const mainGeometry = await bundle.locator(".toolBundleEntry").evaluateAll(entries => entries.map(entry => ({ width: entry.getBoundingClientRect().width, metaWidth: entry.querySelector('.messageMeta')?.getBoundingClientRect().width })));
      assert.ok(mainGeometry.every(entry => entry.metaWidth < entry.width));
      if (!wasOpen) await bundle.locator(":scope > .messageMeta").click();
    }
  }
  await page.locator(".subagentSiblingTabs").getByRole("button", { name: "subagent_assets", exact: true }).click();
  await page.locator(".subagentPanelHeader h2").filter({ hasText: "subagent_assets" }).waitFor();
  await page.locator(".subagentRecord:not(.switching) [data-subagent-item]").first().waitFor();
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".conversationHeader h2").innerText(), sourceThreadTitle);
  assert.equal(await draft.innerText(), draftBefore);
  await page.getByRole("button", { name: "收起子代理面板" }).click();
  await page.locator(".rightPaneSubagents").waitFor({ state: "detached" });
  await page.waitForTimeout(450);
  assert.ok(await rail.evaluate(element => Number(getComputedStyle(element).opacity) > 0 && getComputedStyle(element).visibility === "visible" && !element.inert));
  await page.locator(".v2ThemeToggle").click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${screenshots}/03-central-light.png` });
  await page.locator(".subagentActivity .subagentHistoryButton").click();
  await page.getByRole('searchbox', { name: '搜索子代理名称或模型' }).fill('subagent_history_backend');
  await row.waitFor();
  await row.click();
  await page.locator(".subagentRecord:not(.switching) [data-subagent-item]").first().waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${screenshots}/04-full-record-light.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const closeBox = await page.getByRole("button", { name: "收起子代理面板" }).boundingBox();
  assert.ok(closeBox.x >= 0 && closeBox.x + closeBox.width <= 390 && closeBox.y >= 0 && closeBox.y + closeBox.height <= 844);
  await page.screenshot({ path: `${screenshots}/05-full-record-mobile-light.png` });
  if (!baseline) {
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${screenshots}/05b-full-record-mobile-dark.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  }
  await page.getByRole("button", { name: "收起子代理面板" }).click();
  await page.locator(".rightPaneSubagents").waitFor({ state: "detached" });
  // Verify the new skill is discoverable from the real runtime, without sending.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole("button", { name: "插件", exact: true }).click();
  await page.locator(".skillPickerList").getByRole("button", { name: /LaTeX \/ Word 写作/ }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "关闭技能选择器" }).click();
  await page.locator(".skillPickerPopover").waitFor({ state: "detached" });
  await draft.fill("/Word");
  await page.getByRole("option", { name: /LaTeX \/ Word 写作/ }).waitFor();
  await page.getByRole("option", { name: /LaTeX \/ Word 写作/ }).click();
  await page.locator(".selectedSkillChip").filter({ hasText: /LaTeX \/ Word 写作/ }).waitFor();
  assert.ok(!(await draft.innerText()).includes("SKILL.md"));
  await page.getByRole("button", { name: "折叠侧边栏", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await page.locator(".selectedSkillChip").filter({ hasText: /LaTeX \/ Word 写作/ }).waitFor({ state: "visible" });
  await page.screenshot({ path: `${screenshots}/06-writing-skill-mobile.png` });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", mode: production ? "production" : "new UI + real native logs", baseline, directoryRows, olderParentRequests, hiddenRail, modelBadge, items, types, metrics, selection, screenshots }));
} catch (error) {
  if (page) { await page.screenshot({ path: `${screenshots}/failure.png` }); console.error(JSON.stringify({ error: String(error), screenshots })); }
  throw error;
} finally { await browser.close(); if (injected) await injected.close(); store?.close(); }
