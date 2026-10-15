import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const baseUrl = process.env.THREAD_ACTIVITY_QA_URL || "http://127.0.0.1:4590";
const chromiumPath = process.env.DOCUMENT_QA_CHROMIUM || undefined;
const screenshots = await fs.mkdtemp("/tmp/codex-thread-activity-");
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, reducedMotion: "no-preference" });
  page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/tests/threadActivity.browser.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Current conversation goal" }).waitFor({ state: "detached" }).catch(() => {});
  await page.getByTestId("thread-id").waitFor();
  await page.waitForFunction(() => window.__threadActivityFixture?.sent.some(message => message.type === "goal.get" && message.threadId === "thread-a"));

  const sent = () => page.evaluate(() => window.__threadActivityFixture.sent);
  const ackLatest = async (type, data) => {
    const request = [...await sent()].reverse().find(message => message.type === type);
    assert.ok(request, `expected a ${type} request`);
    await page.evaluate(({ requestId, data }) => window.__threadActivityFixture.ack(requestId, { data }), { requestId: request.requestId, data });
  };
  const goalData = (threadId, objective, status = "active", execution = { state: "started", turnId: "turn-1" }) => ({
    goal: { threadId, objective, status, tokensUsed: 425, tokenBudget: 8000 }, execution
  });
  const checkGoalHover = async theme => {
    const buttons = page.locator(".goalProgressRow > button");
    assert.equal(await buttons.count(), 4, "goal heading and all three controls are present");
    const style = locator => locator.evaluate(element => {
      const computed = getComputedStyle(element);
      return { background: computed.backgroundColor, color: computed.color, radius: parseFloat(computed.borderRadius), property: computed.transitionProperty, duration: computed.transitionDuration, ease: computed.transitionTimingFunction };
    });
    const alpha = value => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return channels.length === 4 ? channels[3] : 1;
    };
    for (let index = 0; index < await buttons.count(); index += 1) {
      const button = buttons.nth(index);
      await page.mouse.move(5, 5);
      await page.waitForTimeout(340);
      const idle = await style(button);
      assert.equal(alpha(idle.background), 0, "idle control has no highlighted rectangle");
      assert.ok(idle.radius >= 8, "goal heading and controls share rounded hover corners");
      assert.equal(idle.property, "background-color");
      assert.ok(parseFloat(idle.duration) > 0);
      assert.match(idle.ease, /cubic-bezier/);
      await button.hover();
      if (index === 0) {
        await page.waitForTimeout(35);
        const entering = await style(button);
        assert.ok(alpha(entering.background) > 0 && alpha(entering.background) < (theme === "light" ? .035 : .04), "heading fades into hover instead of switching immediately");
      }
      await page.waitForTimeout(340);
      const hovered = await style(button);
      assert.ok(alpha(hovered.background) > 0 && alpha(hovered.background) <= .041, "hover stays subtle in both themes");
      const channels = hovered.background.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
      assert.equal(channels[0], channels[1], "neutral hover has no green tint");
      assert.equal(channels[1], channels[2]);
      assert.equal(hovered.color, idle.color, "hover never abruptly brightens the text");
      await page.screenshot({ path: `${screenshots}/goal-hover-${theme}-${index}.png` });
      await page.mouse.move(5, 5);
      if (index === 0) {
        await page.waitForTimeout(35);
        const leaving = await style(button);
        assert.ok(alpha(leaving.background) > 0 && alpha(leaving.background) < alpha(hovered.background), "heading also fades out on mouse leave");
      }
      await page.waitForTimeout(340);
      assert.equal(alpha((await style(button)).background), 0);
    }
  };
  const waitForVisualSettle = async () => {
    await page.evaluate(async () => {
      const finiteActive = () => document.getAnimations().filter(animation => {
        const timing = animation.effect?.getComputedTiming();
        return animation.playState === "running" && timing && Number.isFinite(timing.iterations);
      });
      await Promise.all(finiteActive().map(animation => animation.finished.catch(() => {})));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.toolReveal[aria-hidden="false"]')].every(element => Number(getComputedStyle(element).opacity) >= .999));
    await page.evaluate(async () => {
      const finiteActive = () => document.getAnimations().filter(animation => {
        const timing = animation.effect?.getComputedTiming();
        return animation.playState === "running" && timing && Number.isFinite(timing.iterations);
      });
      await Promise.all(finiteActive().map(animation => animation.finished.catch(() => {})));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.toolReveal[aria-hidden="false"]')].every(element => Number(getComputedStyle(element).opacity) >= .999));
  };

  await page.evaluate(() => window.__threadActivityFixture.setGoal("Continue revising the article without changing its equations."));
  await page.getByText("正在确认…").waitFor();
  const startRequest = [...await sent()].reverse().find(message => message.type === "goal.set");
  assert.equal(startRequest.threadId, "thread-a");
  assert.equal(startRequest.userId, "mock-user");
  await page.evaluate(({ requestId, data }) => window.__threadActivityFixture.ack(requestId, { data }), {
    requestId: startRequest.requestId,
    data: goalData("thread-a", "Continue revising the article without changing its equations.")
  });
  await page.getByText("持续目标 · 等待继续").waitFor();
  assert.equal(await page.getByRole("button", { name: "暂停目标" }).count(), 1, "goal controls render after persistence/start acknowledgement");
  assert.equal(await page.getByLabel("Conversation history").innerText(), "Conversation history stays empty", "goal acknowledgement is not inserted into chat history");

  await page.getByRole("button", { name: "暂停目标" }).click();
  let request = [...await sent()].reverse().find(message => message.type === "goal.set");
  assert.equal(request.status, "paused");
  await page.evaluate(({ requestId, data }) => window.__threadActivityFixture.ack(requestId, { data }), { requestId: request.requestId, data: goalData("thread-a", "Continue revising the article without changing its equations.", "paused", { state: "inactive" }) });
  await page.getByText("持续目标 · 已暂停").waitFor();
  await page.getByRole("button", { name: "继续目标" }).click();
  request = [...await sent()].reverse().find(message => message.type === "goal.set");
  assert.equal(request.status, "active");
  await page.evaluate(({ requestId, data }) => window.__threadActivityFixture.ack(requestId, { data }), { requestId: request.requestId, data: goalData("thread-a", "Continue revising the article without changing its equations.", "active", { state: "running", turnId: "turn-resumed" }) });
  await page.getByText("持续目标 · 等待继续").waitFor();
  await page.getByRole("button", { name: "结束并清除目标" }).click();
  request = [...await sent()].reverse().find(message => message.type === "goal.clear");
  await page.evaluate(({ requestId, data }) => window.__threadActivityFixture.ack(requestId, { data }), { requestId: request.requestId, data: { threadId: "thread-a", cleared: true } });
  await page.locator(".goalProgress").waitFor({ state: "hidden" });

  // A delayed, explicit post-persistence execution error must remain a retryable status, never a false "running" claim.
  await page.evaluate(() => window.__threadActivityFixture.setGoal("Retryable startup objective"));
  request = [...await sent()].reverse().find(message => message.type === "goal.set");
  await page.getByText("正在确认…").waitFor();
  await page.waitForTimeout(350);
  await page.evaluate(({ requestId, data }) => window.__threadActivityFixture.ack(requestId, { data }), {
    requestId: request.requestId,
    data: goalData("thread-a", "Retryable startup objective", "active", { state: "scheduled", error: "thread is still loading" })
  });
  await page.getByRole("alert").getByText(/目标已保存，启动未确认：thread is still loading/).waitFor();
  assert.equal(await page.getByText("持续目标 · 执行中").count(), 0);

  // Thread/user scoping and the empty-thread view must hide old state and ignore out-of-scope notifications.
  await page.getByRole("button", { name: "Thread B" }).click();
  await page.waitForFunction(() => window.__threadActivityFixture.sent.some(message => message.type === "goal.get" && message.threadId === "thread-b"));
  await page.evaluate(() => window.__threadActivityFixture.notify("thread/goal/updated", { threadId: "thread-a", goal: { threadId: "thread-a", objective: "LEAKED FROM A", status: "active" } }));
  assert.equal(await page.getByText("LEAKED FROM A").count(), 0);
  assert.equal(await page.getByText("Retryable startup objective").count(), 0);
  const threadBGet = [...await sent()].reverse().find(message => message.type === "goal.get" && message.threadId === "thread-b");
  await page.evaluate(({ requestId, data }) => window.__threadActivityFixture.ack(requestId, { data }), { requestId: threadBGet.requestId, data: { threadId: "thread-b", goal: null } });
  await page.getByRole("button", { name: "New empty view" }).click();
  await page.waitForTimeout(350);
  assert.equal(await page.locator(".goalProgress").count(), 0, "empty view eventually removes the collapsed goal row");
  await page.evaluate(() => window.__threadActivityFixture.notify("thread/goal/updated", { threadId: "thread-a", goal: { threadId: "thread-a", objective: "A STILL LEAKED", status: "active" } }));
  assert.equal(await page.getByText("A STILL LEAKED").count(), 0);

  // A same-thread status event updates state, then expansion reveals readable summary and omits encrypted task bytes.
  await page.getByRole("button", { name: "Thread A" }).click();
  await page.waitForFunction(() => window.__threadActivityFixture.sent.some(message => message.type === "goal.get" && message.threadId === "thread-a"));
  await page.evaluate(() => window.__threadActivityFixture.notify("thread/goal/updated", { threadId: "thread-a", goal: { threadId: "thread-a", objective: "Status arrived from the native event", status: "paused" } }));
  await page.getByText("Status arrived from the native event").waitFor();
  await page.getByRole("button", { name: /2 个子代理/ }).click();
  await page.locator(".subagentActivity .subagentName").filter({ hasText: /^qa$/ }).waitFor();
  assert.equal(await page.locator(".subagentActivity .subagentName").allTextContents().then(names => names.join(",")), "editor,qa", "loaded completed records remain in the centralized list");
  await page.locator(".subagentToolCard").getByRole("button", { name: /editor.*已完成/ }).click();
  await page.getByText(/The editor passed its review/).waitFor();
  await waitForVisualSettle();
  const body = await page.locator("body").innerText();
  assert.ok(!body.includes("gAAAAABmockedEncryptedDelegationPayload"), "raw encrypted spawn argument is never rendered");
  assert.ok(body.includes("The editor passed its review."), "native completed status exposes a readable summary after expansion");
  await checkGoalHover("dark");
  const darkScreenshot = `${screenshots}/thread-activity-dark.png`;
  await page.screenshot({ path: darkScreenshot, fullPage: true });
  const contrastRatio = async (selector, raisedSurface = false) => page.locator(selector).first().evaluate((element, raised) => {
    const rgb = value => {
      if (value.startsWith("#")) return value.slice(1).length === 3
        ? value.slice(1).split("").map(char => parseInt(char + char, 16))
        : value.slice(1).match(/.{2}/g).map(part => parseInt(part, 16));
      const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
      if (srgb) return srgb.slice(1, 4).map(channel => Number(channel) * 255);
      return (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    };
    const luminance = value => rgb(value).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const foreground = rgb(getComputedStyle(element).color);
    const panelElement = element.closest(".activityFixture");
    const panelColor = raised ? getComputedStyle(document.documentElement).getPropertyValue("--ui-surface-raised").trim() : getComputedStyle(panelElement).backgroundColor;
    const background = rgb(panelColor);
    let opacity = 1, current = element;
    while (current) {
      opacity *= Number(getComputedStyle(current).opacity || 1);
      if (current === panelElement) break;
      current = current.parentElement;
    }
    const composited = foreground.map((channel, index) => channel * opacity + background[index] * (1 - opacity));
    const luminanceRgb = channels => channels.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const [a, b] = [luminanceRgb(composited), luminanceRgb(background)].sort((x, y) => y - x);
    return { ratio: (a + .05) / (b + .05), ancestorOpacity: opacity };
  }, raisedSurface);
  for (const selector of [".goalProgressStatus", ".subagentName", ".subagentState", ".subagentSummary"]) {
    const panel = await contrastRatio(selector);
    const raised = await contrastRatio(selector, true);
    assert.ok(panel.ancestorOpacity >= .999 && panel.ratio >= 4.5, `${selector} meets visible 4.5:1 text contrast in settled dark theme (ratio ${panel.ratio}, opacity ${panel.ancestorOpacity})`);
    assert.ok(raised.ancestorOpacity >= .999 && raised.ratio >= 4.5, `${selector} meets visible 4.5:1 text contrast on the dark raised surface`);
  }
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await waitForVisualSettle();
  await checkGoalHover("light");
  for (const selector of [".goalProgressStatus", ".subagentName", ".subagentState", ".subagentSummary"]) {
    const panel = await contrastRatio(selector);
    const raised = await contrastRatio(selector, true);
    assert.ok(panel.ancestorOpacity >= .999 && panel.ratio >= 4.5, `${selector} meets visible 4.5:1 text contrast in settled light theme (ratio ${panel.ratio}, opacity ${panel.ancestorOpacity})`);
    assert.ok(raised.ancestorOpacity >= .999 && raised.ratio >= 4.5, `${selector} meets visible 4.5:1 text contrast on the light raised surface`);
  }
  const goalHeadingBox = await page.locator(".goalProgressRow > .threadActivityHeading").boundingBox();
  const agentsHeadingBox = await page.locator(".subagentActivity > .threadActivityHeading").boundingBox();
  assert.ok(goalHeadingBox && agentsHeadingBox && Math.abs(goalHeadingBox.x - agentsHeadingBox.x) <= 1, "goal and agents disclosures share a left edge");
  const lightScreenshot = `${screenshots}/thread-activity-light.png`;
  await page.screenshot({ path: lightScreenshot, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileBounds = await page.locator(".activityFixture").boundingBox();
  assert.ok(mobileBounds && mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 390, "activity panel fits a 390px viewport");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile fixture has no horizontal overflow");
  await waitForVisualSettle();
  const mobileScreenshot = `${screenshots}/thread-activity-mobile-390.png`;
  await page.screenshot({ path: mobileScreenshot, fullPage: true });

  // An older loaded page adds historical rows to the centralized management list.
  await page.evaluate(() => window.__threadActivityFixture.setOlderItems([
    { id: "old-list", type: "toolCall", tool: "list_agents", output: { agents: [{ task_name: "old-worker", status: "completed", model: "gpt-6-luna" }] } }
  ]));
  await page.getByRole("button", { name: /3 个子代理.*1 个执行中/ }).waitFor();
  assert.equal(await page.locator(".subagentActivity").getByText("old-worker").count(), 1);
  await page.evaluate(() => window.__threadActivityFixture.setOlderItems([]));

  // A finished row receives a completion mark and remains directly inspectable.
  await page.evaluate(() => window.__threadActivityFixture.setItems([
    { id: "current-list", type: "toolCall", tool: "list_agents", output: { agents: [
      { task_name: "qa", status: "running", model: "gpt-6-sol" },
      { task_name: "writer", status: "running", model: "gpt-6-luna" }
    ] } }
  ]));
  await page.getByRole("button", { name: /2 个子代理/ }).waitFor();
  const writer = page.locator(".subagentActivity").getByRole("button", { name: /writer/ });
  await writer.waitFor();
  await waitForVisualSettle();
  await page.evaluate(() => window.__threadActivityFixture.setItems([
    { id: "current-list", type: "toolCall", tool: "list_agents", output: { agents: [
      { task_name: "qa", status: "running", model: "gpt-6-sol" },
      { task_name: "writer", status: "completed", model: "gpt-6-luna", summary: "Writer has finished." }
    ] } }
  ]));
  await page.locator(".subagentActivity").getByRole("button", { name: /writer.*已完成/ }).waitFor();
  assert.equal(await writer.locator(".subagentCompletionIcon").count(), 1);
  await page.getByRole("button", { name: /2 个子代理.*1 个执行中/ }).waitFor();
  assert.equal(await page.locator(".subagentToolCard").getByText(/已完成/).count(), 1, "historical completion is still viewable");

  // Verify the production ToolReveal transition under a non-reduced-motion browser preference.
  await page.setViewportSize({ width: 1100, height: 760 });
  assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), false);
  await page.getByRole("button", { name: "Clear agents fixture" }).click();
  const subagentSection = page.locator(".subagentActivity");
  const exitReveal = subagentSection.locator("xpath=../..");
  await page.waitForFunction(() => {
    const section = document.querySelector(".subagentActivity");
    const reveal = section?.parentElement?.parentElement;
    return reveal?.getAttribute("aria-hidden") === "true" && reveal.hasAttribute("inert");
  });
  assert.equal(await subagentSection.count(), 1, "agent content stays mounted as the panel starts to exit");
  await page.waitForTimeout(55);
  const exitStart = await exitReveal.evaluate(element => ({ opacity: Number(getComputedStyle(element).opacity), height: element.getBoundingClientRect().height, duration: getComputedStyle(element).transitionDuration }));
  assert.ok(exitStart.opacity > 0 && exitStart.opacity < 1, `opacity is transitioning (${exitStart.opacity})`);
  assert.ok(exitStart.height > 0 && exitStart.height < 100, `height is transitioning (${exitStart.height})`);
  assert.match(exitStart.duration, /ms|s/);
  await subagentSection.waitFor({ state: "detached", timeout: 2000 });
  assert.equal(await subagentSection.count(), 0, "agent content unmounts after the exit transition settles");

  // Ending the parent run never discards records still in the loaded history.
  await page.evaluate(() => window.__threadActivityFixture.setItems([
    { id: "running-list", type: "toolCall", tool: "list_agents", output: { agents: [{ task_name: "qa", status: "running" }] } }
  ]));
  await subagentSection.waitFor({ state: "visible" });
  await page.evaluate(() => window.__threadActivityFixture.setAgentTurnRunning(false));
  await page.waitForTimeout(400);
  await subagentSection.waitFor({ state: "visible" });
  assert.deepEqual(pageErrors, [], "browser runtime errors");
  console.log(JSON.stringify({ result: "PASS", url: `${baseUrl}/tests/threadActivity.browser.html`, screenshots: { dark: darkScreenshot, light: lightScreenshot, mobile390: mobileScreenshot }, exitTransition: exitStart, socketMessages: (await sent()).map(({ type, threadId, status }) => ({ type, threadId, status })) }, null, 2));
} catch (error) {
  if (page) {
    const shot = `${screenshots}/failure.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(JSON.stringify({ error: String(error), body: await page.locator("body").innerText().catch(() => ""), screenshot: shot }, null, 2));
  }
  throw error;
} finally { await browser.close(); }
