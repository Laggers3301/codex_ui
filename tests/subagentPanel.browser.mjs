import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const screenshots = await fs.mkdtemp("/tmp/codex-subagent-panel-");
const browser = await chromium.launch({ executablePath: process.env.DOCUMENT_QA_CHROMIUM || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, reducedMotion: "no-preference" });
  page = await context.newPage();
  const errors = [], requests = [];
  let activeReads = 0;
  let manualDelay = 0;
  page.on("pageerror", error => errors.push(error.message));
  const item = (id, text) => ({ id, type: "agentMessage", text });
  const turn = (id, items, status = "completed") => ({ id, status, items });
  const result = (id, turns, older = false) => ({ thread: { id, sessionId: id, name: id, cwd: "/test", updatedAt: 1, createdAt: 1, status: "idle", turns }, history: { totalItems: 40, returnedItems: 20, before: 0, nextBefore: 20, hasOlder: older, nextCursor: older ? "older-b" : null } });
  const paragraphs = Array.from({ length: 60 }, (_, index) => item(`b-${index}`, `**编辑记录 ${index}**\n\n保留原始结构和公式；这是子代理自己的完整执行内容，不是主会话里截断后的摘要。`.repeat(3)));
  const activity = Array.from({ length: 60 }, (_, index) => index % 2
    ? { id: `reason-${index}`, type: "reasoning", text: `检查章节 ${index}，保留公式与原稿。`.repeat(30) }
    : { id: `tool-${index}`, type: "toolCall", tool: "exec", input: `rg chapter-${index} source.tex`, aggregatedOutput: "done" });
  const tool = { id: "tool-1", type: "toolCall", tool: "read_file", input: "/test/source.tex", aggregatedOutput: "preview", outputDeferred: true };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, query: url.search, method: request.method() });
    let body;
    if (url.pathname.endsWith("/subagents")) {
      const all = [
      { id: "a", name: "/root/research", parentThreadId: "parent", model: "gpt-6-luna", state: activeReads > 1 ? "completed" : "running" },
      { id: "b", name: "/root/editor", parentThreadId: "parent", model: "gpt-6-luna", state: "completed" },
      { id: "c", name: "/root/compiler", parentThreadId: "parent", state: "interrupted" },
      { id: "d", name: "/root/earlier", parentThreadId: "parent", state: "unknown" },
      { id: "e", name: "/root/activity_history", parentThreadId: "parent", state: "completed" },
      ...Array.from({ length: 67 }, (_, index) => ({ id: `old-${index}`, name: `/root/worker_${index}`, model: "gpt-6-luna", parentThreadId: "parent", state: "completed", createdAt: "2026-10-01T08:00:00.000Z", lastTaskAt: "2026-10-01T09:00:00.000Z" }))
      ];
      const activeCount = all.filter(agent => agent.state === 'running').length;
      const view = url.searchParams.get('view') ?? 'all', q = (url.searchParams.get('q') ?? '').toLowerCase();
      const filtered = all.filter(agent => (view === 'all' || (view === 'active' ? agent.state === 'running' : agent.state !== 'running')) && `${agent.id} ${agent.name} ${agent.model ?? ''}`.toLowerCase().includes(q));
      const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit') ?? 40);
      const data = filtered.slice(offset, offset + limit), hasMore = filtered.length > offset + limit;
      body = { data, page: { total: all.length, activeCount, historyCount: all.length - activeCount, unknownCount: 1, matchedCount: filtered.length, hasMore, nextCursor: hasMore ? String(offset + limit) : null } };
    }
    else if (url.pathname.endsWith("/output")) body = { data: { output: "FULL_OUTPUT_NOT_A_TRUNCATED_SUMMARY" } };
    else if (url.pathname.endsWith("/a")) { activeReads++; body = result("a", [turn("a-turn", [item("a1", "研究过程"), { id: "a-tool", type: "toolCall", tool: "exec", input: "rg research notes.md", completed: true, aggregatedOutput: "done" }, ...(activeReads > 1 ? [item("a2", "研究已完成，新增结果")] : [])], activeReads > 1 ? "completed" : "running")]); }
    else if (url.pathname.endsWith("/b")) {
      const cursor = url.searchParams.get("cursor");
      if (cursor === "older-b") {
        body = result("b", [turn("b-turn", Array.from({ length: 160 }, (_, index) => item(`older-${index}`, `更早完整记录 ${index}\n\n` + "已完成的历史仍可查看。".repeat(12))))], true);
        body.history.nextCursor = "oldest-b";
      } else if (cursor === "oldest-b") body = result("b", [turn("oldest", Array.from({ length: 80 }, (_, index) => item(`oldest-${index}`, `最早完整记录 ${index}\n\n` + "另一轮历史继续原位补载。".repeat(12))))]);
      else body = result("b", [turn("b-turn", [...paragraphs, ...activity, tool, item("final", "编辑器完整最终结果")])], true);
    }
    else if (url.pathname.endsWith("/c")) body = result("c", [turn("c-turn", [item("c1", "编译被停止，已保存过程")], "interrupted")]);
    else if (url.pathname.endsWith("/d")) body = result("d", []);
    else if (url.pathname.endsWith("/e")) {
      const calls = (prefix, length) => Array.from({ length }, (_, index) => ({ id: `${prefix}-${index}`, type: "toolCall", tool: "exec", input: `rg ${prefix}-${index} source.tex`, aggregatedOutput: "done" }));
      if (url.searchParams.get("cursor") === "older-b") body = result("e", [turn("e-turn", calls("previous", 20))]);
      else body = result("e", [turn("e-turn", [...calls("current", 50), item("e-answer", "工具完成后的正文仍独立显示")])], true);
    }
    else return route.fulfill({ status: 404, json: { error: "unknown fixture request" } });
    await new Promise(resolve => setTimeout(resolve, manualDelay || 50));
    await route.fulfill({ json: body });
  });
  await page.goto("http://127.0.0.1:4590/tests/subagentPanel.browser.html");
  await page.getByRole("button", { name: "打开子代理" }).waitFor();
  const delivery = page.locator('.subagentMessageDelivery');
  assert.equal((await delivery.innerText()).replace(/\s+/g, ' ').trim(), '发送协作消息 → 主代理');
  assert.equal(await delivery.locator('button, .subagentState').count(), 0, 'delivery is not a new task and the root is not a child link');
  const deliveryLine = await delivery.locator('.subagentOperation').evaluate(element => ({ height: element.getBoundingClientRect().height, line: Number.parseFloat(getComputedStyle(element).lineHeight) }));
  assert.ok(deliveryLine.height < 29, 'collaboration delivery stays on a compact single line');
  const originalDraft = await page.getByRole("textbox", { name: "主对话草稿" }).inputValue();
  await page.getByRole("button", { name: "打开子代理" }).click();
  await page.getByRole('tab', { name: /进行中 · 1/ }).waitFor();
  await page.locator('.subagentDirectoryRow').filter({ hasText: 'research' }).waitFor();
  assert.equal(requests.filter(request => /\/subagents\/[a-e]$/.test(request.path)).length, 0, 'metadata directory does not fetch child transcripts');
  await page.getByRole('tab', { name: /历史 · 71/ }).click();
  await page.getByRole("button", { name: /editor.*已完成/ }).waitFor();
  assert.ok(await page.locator('.subagentDirectoryRow').count() < 40, 'history directory mounts only the visible metadata window');
  const beforeDirectoryAppend = requests.filter(request => request.path.endsWith('/subagents') && request.query.includes('cursor=')).length;
  const directory = page.locator('.subagentDirectoryResults');
  await directory.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 180; });
  await page.waitForTimeout(300);
  assert.equal(requests.filter(request => request.path.endsWith('/subagents') && request.query.includes('cursor=')).length, beforeDirectoryAppend, 'programmatic restoration never chains directory pages');
  const directoryAnchor = await directory.evaluate(element => {
    const row = [...element.querySelectorAll('[data-agent-id]')].find(row => row.getBoundingClientRect().top >= element.getBoundingClientRect().top + 8);
    return { id: row.dataset.agentId, y: row.getBoundingClientRect().y };
  });
  await directory.dispatchEvent('wheel', { deltaY: 1 });
  await directory.evaluate(element => { element.scrollTop += 1; });
  await page.waitForFunction(() => document.querySelector('.subagentDirectoryPaging'));
  await page.locator('.subagentDirectoryPaging').waitFor({ state: 'detached' });
  await page.waitForTimeout(400);
  assert.ok(Math.abs((await page.locator(`[data-agent-id="${directoryAnchor.id}"]`).boundingBox()).y - directoryAnchor.y) < 2, 'directory append keeps the visible record in place');
  assert.equal(requests.filter(request => request.path.endsWith('/subagents') && request.query.includes('cursor=')).length, beforeDirectoryAppend + 1, 'one down gesture loads one directory page');
  await page.getByRole('searchbox', { name: '搜索子代理名称或模型' }).fill('worker_66');
  await page.getByRole('button', { name: /worker_66/ }).waitFor();
  assert.equal(await page.locator('.subagentDirectoryRow').count(), 1, 'search finds a child beyond the old 64-row cap');
  await page.getByRole('searchbox', { name: '搜索子代理名称或模型' }).fill('');
  await directory.evaluate(element => { element.scrollTop = 0; });
  await page.getByRole('button', { name: /editor.*已完成/ }).waitFor();
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${screenshots}/directory-dark.png` });
  const identity = await page.locator(".subagentDirectoryRow").filter({ hasText: "editor" }).locator(".subagentAvatar").getAttribute("class");
  await page.getByRole("button", { name: /editor.*已完成/ }).click();
  await page.getByText("编辑器完整最终结果").waitFor();
  await page.waitForTimeout(450);
  assert.equal(await page.locator(".subagentPanelHeader .subagentAvatar").getAttribute("class"), identity);
  assert.ok(await page.locator(".subagentRecord [data-subagent-item]").count() < 80, "a bounded viewport, not every loaded row, is mounted");
  assert.equal(await page.locator(".subagentRecord .reasoningExpandedBody").count(), 0, "collapsed summaries do not mount hidden Markdown");
  assert.equal(await page.locator(".subagentOlderButton").count(), 0, "history loads by scrolling, without a manual button");
  const bundle = page.locator(".subagentRecord .toolBundle");
  assert.equal(await bundle.count(), 1, "one consecutive block becomes one cluster, not 61 separate activity rows");
  assert.equal((await bundle.locator(":scope > .toolBundleTitle").innerText()).trim(), "调用工具 · 工具 × 31");
  assert.equal(await bundle.locator(".toolBundleEntry, .reasoningDisclosure").count(), 0, "a closed cluster does not mount hidden tools or thoughts");
  await bundle.locator(":scope > .toolBundleTitle").click();
  await bundle.locator(".toolBundleEntries").waitFor();
  await page.waitForTimeout(350);
  assert.equal(await bundle.locator(".toolBundleEntry").count(), 31);
  assert.equal(await bundle.locator(".reasoningDisclosure").count(), 30);
  assert.equal(await bundle.getAttribute("aria-expanded"), "true");
  await page.locator(".subagentRecord .toolBundleEntry").filter({ hasText: "调用工具 · read_file" }).click();
  await page.getByText("FULL_OUTPUT_NOT_A_TRUNCATED_SUMMARY").waitFor();
  assert.equal(requests.filter(request => request.path.endsWith("/output")).length, 1, "tool output is lazy and StrictMode-safe");
  await page.locator(".subagentRecord .toolBundleEntry").filter({ hasText: "调用工具 · read_file" }).click();
  await page.locator(".subagentRecord .toolBundleEntry").filter({ hasText: "调用工具 · read_file" }).click();
  assert.equal(requests.filter(request => request.path.endsWith("/output")).length, 1);
  assert.equal(await bundle.getAttribute("aria-expanded"), "true", "opening a nested tool never closes its cluster");
  await bundle.locator(":scope > .toolBundleTitle").click();
  await page.waitForTimeout(90);
  const bundleExit = await bundle.locator(":scope > .toolReveal").evaluate(element => ({ opacity: Number(getComputedStyle(element).opacity), ease: getComputedStyle(element).transitionTimingFunction, inert: element.inert }));
  assert.ok(bundleExit.opacity > 0 && bundleExit.opacity < 1 && bundleExit.inert && bundleExit.ease.includes("cubic-bezier"), "cluster closing retains its nonlinear fade");
  await bundle.locator(".toolBundleEntries").waitFor({ state: "detached" });
  const rendersBeforeSelection = await page.evaluate(() => window.subagentFixtureMainRenders);
  await page.locator(".subagentRecordAnswer").filter({ hasText: "编辑器完整最终结果" }).evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    for (let index = 0; index < 30; index++) document.dispatchEvent(new Event("selectionchange"));
  });
  await page.getByRole("button", { name: "在侧边提问", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.subagentFixtureMainRenders), rendersBeforeSelection, "selection updates never re-render the main chat");
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator(".selectionAskButton").waitFor({ state: "detached" });
  // A real upward intent disables following. Setting a scroll position alone
  // never fetches a page; restoration therefore cannot cascade B -> C -> D.
  await page.locator(".subagentRecord").dispatchEvent("wheel", { deltaY: -1 });
  await page.waitForTimeout(1600);
  const anchors = [];
  const earlierReads = () => requests.filter(request => request.path.endsWith('/b') && request.query.includes("cursor=")).length;
  for (let pass = 0; pass < 2; pass++) {
    await page.locator(".subagentRecord").evaluate(element => { element.scrollTop = 220; });
    await page.waitForTimeout(500);
    assert.equal(earlierReads(), pass, "programmatic scroll/measurement does not load another page");
    const anchor = await page.locator(".subagentRecord").evaluate(element => {
      const rows = [...element.querySelectorAll("[data-subagent-item]")];
      const top = element.getBoundingClientRect().top;
      const row = rows.find(row => row.getBoundingClientRect().top >= top + 8) || rows.find(row => row.getBoundingClientRect().bottom > top);
      return { id: row.dataset.subagentItem, top: row.getBoundingClientRect().top };
    });
    await page.locator(".subagentRecord").dispatchEvent("wheel", { deltaY: -1 });
    await page.waitForFunction(() => document.querySelector('.subagentHistoryLoading'));
    await page.locator(".subagentHistoryLoading").waitFor({ state: "detached" });
    await page.waitForTimeout(1100);
    const anchored = await page.locator(`[data-subagent-item="${anchor.id}"]`).boundingBox();
    assert.ok(anchored && Math.abs(anchored.y - anchor.top) < 2, `page ${pass + 1} preserves the visible text, including a prepend inside the same turn`);
    assert.equal(earlierReads(), pass + 1, "exactly one page per upward gesture");
    anchors.push({ id: anchor.id, drift: anchored.y - anchor.top });
  }
  assert.ok(requests.some(request => request.query.includes("cursor=older-b")), "frontend and backend use the same cursor contract");
  const beforePoll = await page.locator(".subagentRecord").evaluate(element => element.scrollTop);
  const refreshBefore = { directory: requests.filter(request => request.path.endsWith('/subagents')).length, record: requests.filter(request => request.path.endsWith('/b') && !request.query.includes('cursor=')).length };
  manualDelay = 650;
  const refreshButton = page.getByRole('button', { name: '刷新子代理记录' });
  await refreshButton.click();
  await page.getByRole('status', { name: '正在读取子代理记录' }).waitFor();
  assert.equal(await refreshButton.getAttribute('aria-busy'), 'true');
  assert.equal(await refreshButton.isDisabled(), true);
  assert.equal(await page.locator('.subagentRecord.switching').count(), 0, 'manual refresh keeps current transcript visible');
  assert.equal(await page.locator('.subagentLoadingLayer .threadOpeningPulse i').count(), 3, 'refresh reuses the main-chat three-dot indicator');
  await page.screenshot({ path: `${screenshots}/record-refresh.png` });
  await page.waitForFunction(() => document.querySelector('[aria-label="刷新子代理记录"]').getAttribute('aria-busy') === 'false');
  const loadingExit = await page.locator('.subagentLoadingLayer').evaluate(element => ({ closing: element.classList.contains('closing'), animation: getComputedStyle(element.querySelector('.threadOpeningIndicator')).animationName }));
  assert.deepEqual(loadingExit, { closing: true, animation: 'threadOpeningHide' }, 'refresh feedback fades out instead of disappearing');
  await page.locator('.subagentLoadingLayer').waitFor({ state: 'detached' });
  manualDelay = 0;
  assert.ok(requests.filter(request => request.path.endsWith('/subagents')).length > refreshBefore.directory);
  assert.equal(requests.filter(request => request.path.endsWith('/b') && !request.query.includes('cursor=')).length, refreshBefore.record + 1);
  assert.ok(Math.abs(await page.locator('.subagentRecord').evaluate(element => element.scrollTop) - beforePoll) < 2, 'manual refresh preserves the history window and reading anchor');
  await page.waitForTimeout(5200);
  assert.ok(Math.abs(await page.locator(".subagentRecord").evaluate(element => element.scrollTop) - beforePoll) < 2, "directory polling never resets the selected transcript or history window");
  // A page can join an already expanded cluster, not just prepend whole rows.
  // Anchor a specific call inside that cluster, and preserve both its open state
  // and the exact reading position when the new calls arrive above it.
  await page.locator(".subagentSiblingTabs").getByRole("button", { name: "activity_history", exact: true }).click();
  await page.getByText("工具完成后的正文仍独立显示").waitFor();
  const openHistoryBundle = page.locator(".subagentRecord .toolBundle");
  const clusterKey = await openHistoryBundle.getAttribute("data-message-key");
  await openHistoryBundle.locator(":scope > .toolBundleTitle").click();
  await page.waitForTimeout(400);
  await page.locator(".subagentRecord").evaluate(element => { element.scrollTop = 220; });
  await page.waitForTimeout(500);
  const innerAnchor = await page.locator(".subagentRecord").evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll(".subagentBundleItem")].find(row => row.getBoundingClientRect().top >= top + 8);
    return { id: row.dataset.messageKey, top: row.getBoundingClientRect().top };
  });
  await page.locator(".subagentRecord").dispatchEvent("wheel", { deltaY: -1 });
  await page.locator(".subagentHistoryLoading").waitFor();
  await page.locator(".subagentHistoryLoading").waitFor({ state: "detached" });
  await page.waitForTimeout(1100);
  assert.equal(await openHistoryBundle.getAttribute("data-message-key"), clusterKey);
  assert.equal(await openHistoryBundle.getAttribute("aria-expanded"), "true", "a partial history prepend never collapses the open cluster");
  assert.equal(await openHistoryBundle.locator(".toolBundleEntry").count(), 70);
  const innerBox = await page.locator(`.subagentBundleItem[data-message-key="${innerAnchor.id}"]`).boundingBox();
  assert.ok(innerBox && Math.abs(innerBox.y - innerAnchor.top) < 2, "visible call stays fixed when older calls join inside its open cluster");
  anchors.push({ id: innerAnchor.id, drift: innerBox.y - innerAnchor.top, openCluster: true });
  await page.getByRole("button", { name: "research", exact: true }).click();
  await page.getByText("研究过程").waitFor();
  await page.locator(".subagentRecord .toolBundleShimmering").waitFor();
  const runningShimmer = await page.locator(".subagentRecordModel .subagentRunningShimmer").evaluate(element => ({ animation: getComputedStyle(element).animationName, gradient: getComputedStyle(element).backgroundImage }));
  assert.equal(runningShimmer.animation, "v2-seamless-shimmer");
  assert.ok(runningShimmer.gradient.includes("linear-gradient"));
  await page.getByText("研究已完成，新增结果").waitFor({ timeout: 5000 });
  assert.equal(await page.locator(".subagentRecord .toolBundleShimmering").count(), 0, "a new body/completion stops activity shimmer");
  await page.getByRole("button", { name: "返回子代理列表" }).click();
  await page.getByRole('tab', { name: /历史/ }).click();
  await page.getByRole("button", { name: /research.*已完成/ }).waitFor({ timeout: 6000 });
  await page.getByRole("button", { name: /editor.*已完成/ }).click();
  await page.getByText("编辑器完整最终结果").waitFor();
  assert.equal(await page.getByRole("textbox", { name: "主对话草稿" }).inputValue(), originalDraft);
  await page.waitForTimeout(450);
  const darkSurface = await page.locator(".rightPaneSubagents").evaluate(element => ({ background: getComputedStyle(element).backgroundColor, blur: getComputedStyle(element).backdropFilter, base: getComputedStyle(document.body).backgroundColor }));
  assert.equal(darkSurface.background, darkSurface.base);
  assert.equal(darkSurface.blur, "none");
  await page.screenshot({ path: `${screenshots}/record-dark.png` });
  await page.getByRole("button", { name: "切换日夜" }).click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${screenshots}/record-light.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(450);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile page has no horizontal overflow");
  for (const label of ["收起子代理面板", "返回子代理列表"]) {
    const box = await page.getByRole("button", { name: label }).boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844);
  }
  const headerAlignment = await page.locator('.subagentPanelHeader').evaluate(header => {
    const model = header.querySelector('.subagentRecordModel').getBoundingClientRect(), refresh = header.querySelector('[aria-label="刷新子代理记录"]').getBoundingClientRect(), title = header.querySelector('h2').getBoundingClientRect();
    return { modelRight: model.right, refreshLeft: refresh.left, modelY: model.y + model.height / 2, refreshY: refresh.y + refresh.height / 2, titleWidth: title.width };
  });
  assert.ok(headerAlignment.modelRight <= headerAlignment.refreshLeft && Math.abs(headerAlignment.modelY - headerAlignment.refreshY) < 2 && headerAlignment.titleWidth > 20, 'mobile model badge is aligned just before refresh without crowding away the title');
  await page.screenshot({ path: `${screenshots}/record-mobile-light.png` });
  await page.getByRole("button", { name: "收起子代理面板" }).click();
  await page.waitForTimeout(100);
  const exit = await page.locator(".rightPaneSubagents").evaluate(element => ({ opacity: Number(getComputedStyle(element).opacity), ease: getComputedStyle(element).transitionTimingFunction, inert: element.inert }));
  assert.ok(exit.opacity > 0 && exit.opacity < 1 && exit.inert && exit.ease.includes("cubic-bezier"));
  await page.locator(".rightPaneSubagents").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "editor gpt-6-luna 已派发" }).click();
  await page.getByText("编辑器完整最终结果").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole('tab', { name: /历史/ }).click();
  await page.getByRole("button", { name: /editor.*已完成/ }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${screenshots}/directory-mobile-light.png` });
  await page.keyboard.press("Escape");
  await page.locator(".rightPaneSubagents").waitFor({ state: "detached" });
  const activityAgent = { id: 'a', name: '/root/research', model: 'gpt-6-luna' };
  await page.evaluate(agent => window.setSubagentFixtureActivity({ agents: [{ ...agent, state: 'running' }], running: true, task: 'lifecycle' }), activityAgent);
  const activityStrip = page.locator('.fixtureActivity .subagentActivity');
  await activityStrip.getByRole('button', { name: /子代理 · 1 个进行中/ }).click();
  await activityStrip.getByRole('button', { name: /research.*执行中/ }).waitFor();
  await page.evaluate(agent => window.setSubagentFixtureActivity({ agents: [{ ...agent, state: 'completed' }], running: true, task: 'lifecycle' }), activityAgent);
  await activityStrip.getByRole('button', { name: /research.*已完成/ }).waitFor();
  await page.evaluate(agent => window.setSubagentFixtureActivity({ agents: [{ ...agent, state: 'completed' }], running: false, task: 'lifecycle' }), activityAgent);
  await page.waitForTimeout(90);
  const activityExit = await activityStrip.locator('.subagentCurrentActivity').evaluate(element => ({ opacity: Number(getComputedStyle(element).opacity), inert: element.inert, ease: getComputedStyle(element).transitionTimingFunction }));
  assert.ok(activityExit.inert && activityExit.opacity > 0 && activityExit.opacity < 1 && activityExit.ease.includes('cubic-bezier'), 'completed activity folds with a nonlinear fade, not destruction');
  await activityStrip.locator('.subagentRow').waitFor({ state: 'detached' });
  assert.equal(await activityStrip.locator('button').count(), 1, 'idle composer is only the persistent history entry');
  assert.equal(await activityStrip.innerText(), '子代理记录 · 72');
  await page.evaluate(agent => window.setSubagentFixtureActivity({ agents: [{ ...agent, state: 'running' }], running: true, task: 'second-task' }), activityAgent);
  await activityStrip.getByRole('button', { name: /research.*执行中/ }).waitFor();
  await activityStrip.getByRole('button', { name: /research.*执行中/ }).click();
  await page.getByText('研究已完成，新增结果').waitFor();
  await page.evaluate(agent => window.setSubagentFixtureActivity({ agents: [{ ...agent, state: 'completed' }], running: false, task: 'second-task' }), activityAgent);
  await page.waitForTimeout(450);
  assert.equal(await page.locator('.rightPaneSubagents.open').count(), 1, 'finishing a task never closes an opened child transcript');
  await page.getByRole('button', { name: '收起子代理面板' }).click();
  await page.locator('.rightPaneSubagents').waitFor({ state: 'detached' });
  await activityStrip.locator('.subagentHistoryButton').click();
  await page.getByRole('tab', { name: /历史 · 72/ }).waitFor();
  await page.getByRole('searchbox', { name: '搜索子代理名称或模型' }).fill('worker_66');
  await page.getByRole('button', { name: /worker_66/ }).waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${screenshots}/directory-mobile-search.png` });
  const searchBox = await page.getByRole('searchbox', { name: '搜索子代理名称或模型' }).evaluate(element => ({ size: getComputedStyle(element).fontSize, x: element.getBoundingClientRect().x, right: element.getBoundingClientRect().right }));
  assert.ok(searchBox.size === '16px' && searchBox.x >= 0 && searchBox.right <= 390, 'mobile search is visible and does not trigger sub-16px focus zoom');
  await page.getByRole('button', { name: '收起子代理面板' }).click();
  await page.locator('.rightPaneSubagents').waitFor({ state: 'detached' });
  assert.ok(requests.every(request => request.method === "GET"), "viewing child history never writes a chat or creates a normal thread");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", screenshots, exit, activityExit, bundleExit, darkSurface, anchors, requests: requests.length }));
} catch (error) {
  if (page) { await page.screenshot({ path: `${screenshots}/failure.png` }); console.error(JSON.stringify({ error: String(error), body: (await page.locator("body").innerText()).slice(-1800), screenshots })); }
  throw error;
} finally { await browser.close(); }
