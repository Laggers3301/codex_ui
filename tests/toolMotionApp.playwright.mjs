import { chromium, webkit } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHmac } from "node:crypto";
const origin = process.env.QA_ORIGIN ?? "http://127.0.0.1:5216";
let productionCookie = null;
if (process.env.QA_ORIGIN) {
  assert.equal(origin, "http://127.0.0.1:4574", "production build QA is loopback only");
  const secret = (await fs.readFile(new URL("../data/auth/session-secret", import.meta.url), "utf8")).trim();
  const payload = Buffer.from(JSON.stringify({ u: "qa-user", exp: Date.now() + 180000 })).toString("base64url");
  productionCookie = payload + "." + createHmac("sha256", secret).update(payload).digest("base64url");
}
const evidence = process.env.QA_EVIDENCE ?? "./output/qa/tool-motion-app-20261024";
await fs.mkdir(evidence, { recursive: true });
const project = { id: "motion-project", name: "工具动效验收", rootPath: "/test", userId: "sample-user", defaultModel: "gpt-6.1-sol", defaultReasoningEffort: "medium", defaultSandbox: "danger-full-access", defaultApprovalPolicy: "never" };
const thread = { id: "motion-thread", name: "完整会话工具动效", cwd: "/test", updatedAt: 1, createdAt: 1, status: "active", turns: [{ id: "motion-turn", status: "running", items: [{ id: "user", type: "userMessage", text: "验证延迟到达的工具调用和数字基线" }] }] };
const errors = [], results = [];
const quota = { account: { type: "chatgpt" }, rateLimits: { primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: "2026-10-31T00:00:00Z" } }, resetCredits: null, usage: null, errors: [], updatedAt: "2026-10-24T01:00:00Z" };
for (const [engine, type] of [["chromium", chromium], ["webkit", webkit]]) {
  let browser;
  try { browser = await type.launch({ headless: true }); }
  catch (error) { if (engine === "webkit" && /Executable doesn't exist|libavif\.so\.13/.test(error.message)) { results.push({ engine, unavailable: true, reason: "Local WebKit runtime missing its executable or libavif.so.13; not tested on iOS Safari" }); continue; } throw error; }
  try {
    for (const theme of ["dark", "light"]) for (const mobile of [true, false]) {
      if(process.env.QA_DEVICE && process.env.QA_DEVICE!==(mobile?'mobile':'desktop'))continue;
      if(process.env.QA_THEME && process.env.QA_THEME!==theme)continue;
      const page = await browser.newPage({ viewport: mobile ? { width: 393, height: 852 } : { width: 1280, height: 900 } });
      if (productionCookie) await page.context().addCookies([{ name: "codex_remote_session_4575", value: productionCookie, url: origin, httpOnly: true, sameSite: "Lax" }]);
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem("codex-web-composer-height", "520");
        localStorage.setItem("codex-web-user-id", "sample-user");
        localStorage.setItem("codex-v2-project-sample-user", "motion-project");
        localStorage.setItem("codex-v2-expanded-projects-sample-user", '["motion-project"]');
        class Socket extends EventTarget {
          static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; readyState = 0;
          constructor() { super(); window.motionSocket = this; this.tools = []; this.reason = JSON.parse(sessionStorage.getItem('qa-reasoning-snapshot') ?? 'null'); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); this.emit({ type: "hello", data: { liveState: this.snapshot(), turnProgress: [], pendingServerRequests: [] } }); }, 30); }
          snapshot() { return { activeTurns: [{ threadId: "motion-thread", turnId: "motion-turn", status: "running", startedAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" }], agentMessages: [], toolItems: this.tools, reasoningMessages: this.reason ? [this.reason] : [] }; }
          summary(text, completed = false) { this.reason = { itemId: "reason-first", threadId: "motion-thread", turnId: "motion-turn", text, completed, sequence: 1, startedAt: "2020-01-01T00:00:00Z", updatedAt: new Date().toISOString() }; sessionStorage.setItem('qa-reasoning-snapshot', JSON.stringify(this.reason)); this.emit({ type: "live.reasoning", data: this.reason }); }
          emit(item) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(item) })); }
          burst(n, snapshotOnly = false) { for (let i = 0; i < n; i++) { const id = this.tools.length + 1; this.emit({ type: "live.reasoning", data: { itemId: `blank-reason-${id}`, threadId: "motion-thread", turnId: "motion-turn", text: "", completed: false, sequence: id * 3, startedAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" } }); const item = { itemId: `tool-${id}`, threadId: "motion-thread", turnId: "motion-turn", tool: "exec", input: "只读测试", output: "ok", completed: true, startedAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" }; this.tools.push(item); if (!snapshotOnly) this.emit({ type: "live.tool", data: item }); } if (snapshotOnly) this.emit({type:"live.state",data:this.snapshot()}); }
          send(raw) { const item = JSON.parse(raw); if (item.type === "transport.ping") this.emit({ type: "transport.pong" }); else if (item.type === "live.state") this.emit({ type: "live.state", data: this.snapshot() }); else if (item.requestId) this.emit({ type: "ack", requestId: item.requestId, ok: true, data: { data: [] } }); }
          close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
        }
        window.WebSocket = Socket;
      });
      let includeReasoningHistory = false;
      let fixtureCompleted = false;
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        let json = { data: [] };
        if (path === "/api/projects") json = { data: [project], projectRoot: "/test" };
        else if (path === "/api/users") json = { data: [{ id: "sample-user", name: "sample-user" }], defaultUserId: "sample-user" };
        else if (path === "/api/pets") json = { pets: [], activePetId: null, visible: false, position: null };
        else if (path === "/api/projects/motion-project/threads") json = { data: [thread] };
        else if (path === "/api/threads/motion-thread") json = { thread: includeReasoningHistory ? { ...thread, turns: [{ ...thread.turns[0], items: [...thread.turns[0].items, { id: "reason-first", type: "reasoning", summary: ["先到"], timelineAt: "2020-01-01T00:00:00Z" }, { id: "history-answer", type: "agentMessage", text: "历史正文", timelineAt: "2020-01-01T00:00:02Z" }] }] } : thread, history: { totalItems: 1, returnedItems: 1, before: 0, hasOlder: false } };
        else if (path.endsWith("/execution-settings")) json = { data: { sandbox: "danger-full-access", approvalPolicy: "never" } };
        else if (path.endsWith("/context")) json = { data: null };
        else if (path.endsWith("/side-chat")) json = { data: null };
        else if (path.endsWith("/subagents")) json = { data: [], page: { total: 0, activeCount: 0, historyCount: 0, hasMore: false } };
        else if (path === "/api/codex/account-pool") json = { data: { accounts: ["100004", "100001", "100002", "100003"].map(id => ({ id, label: id, health: "ready", quota })), currentThreadAccountId: "100001" } };
        else if (path === "/api/codex/provider-quotas") json = { data: { loading: false, items: [
          { id: "ark", name: "Ark", status: "ready", periods: [{ label: "session", usedPercent: 17.88, resetsAt: "2026-10-24T13:01:14+08:00" }, { label: "weekly", usedPercent: 80.79, resetsAt: "2026-10-26T00:00:00+08:00" }], updatedAt: "2026-10-24T01:00:00Z", stale: false, message: null },
          { id: "mimo", name: "MiMo", status: "auth_required", periods: [], updatedAt: null, stale: false, message: "MiMo 需要控制台登录授权，当前不可查询。" }
        ] } };
        else if (path === "/api/models") json = { data: [{ id: "sol", label: "Sol", model: "gpt-6.1-sol", effort: "medium" }] };
        if (fixtureCompleted && json.thread) json.thread={...json.thread,status:'completed',turns:json.thread.turns.map(turn=>({...turn,status:'completed',completedAt:Date.now()}))};
        await route.fulfill({ json });
      });
      await page.goto(origin + "/?project=motion-project&thread=motion-thread");
      await page.getByText("验证延迟到达的工具调用和数字基线", { exact: true }).waitFor();
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.evaluate(() => window.motionSocket.summary("先到的思考摘要"));
      await page.getByText("先到的思考摘要", { exact: true }).waitFor({ state: "visible", timeout: 2000 });
      await page.evaluate(() => window.motionSocket.summary("先到的思考摘要，继续增量"));
      await page.getByText("先到的思考摘要，继续增量", { exact: true }).waitFor({ state: "visible", timeout: 2000 });
      assert.equal(await page.locator(".reasoningSummaryPreview").count(), 1, "summary streams before tools and history refresh, without duplicate rows");
      await page.evaluate(() => window.motionSocket.emit({ type: "live.state", data: window.motionSocket.snapshot() }));
      await page.getByText("先到的思考摘要，继续增量", { exact: true }).waitFor();
      assert.equal(await page.locator(".reasoningSummaryPreview").count(), 1, "reconnect snapshot deduplicates reasoning by ID");
      await page.evaluate(() => window.motionSocket.burst(1, true));
      const bundle = page.locator(".toolBundle").first();
      await bundle.waitFor();
      const enter = await bundle.evaluate(element => element.getAnimations().map(animation => ({ name: animation.animationName, duration: animation.effect.getTiming().duration })));
      assert.ok(enter.some(animation => animation.name === "toolBundleArrive" && animation.duration >= 300), "even a completed tool with an old server timestamp must fade in: " + JSON.stringify({enter, state: await bundle.evaluate(element => ({className:element.className, animation:getComputedStyle(element).animation, html:element.outerHTML.slice(0,700)}))}));
      await page.waitForTimeout(350);
      const alignment = await bundle.locator(".toolBundleTitleLabel").evaluate(label => {
        const text = [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).at(-1);
        const prefix = document.createRange(); prefix.selectNodeContents(text);
        const digit = document.createRange(); digit.selectNodeContents(label.querySelector(".toolRollingCountNew"));
        const a = prefix.getBoundingClientRect(), b = digit.getBoundingClientRect();
        return { prefixTop: a.top, digitTop: b.top, prefixBottom: a.bottom, digitBottom: b.bottom };
      });
      assert.ok(Math.abs(alignment.prefixBottom - alignment.digitBottom) < 1.5, "numeric text shares the actual surrounding text baseline: " + JSON.stringify(alignment));
      const counter = bundle.locator(".toolRollingCount");
      const shimmerBefore = await counter.evaluate(element => {
        const title = element.closest(".toolBundleTitleLabel");
        const animation = title.getAnimations().find(animation => animation.animationName === "toolTitleShimmer");
        const glyph = element.querySelector(".toolCountGlyph");
        const titleStyle = getComputedStyle(title), digitStyle = getComputedStyle(glyph);
        return { time: animation?.currentTime, background: digitStyle.backgroundImage, phase: digitStyle.backgroundPosition, rootPhase: titleStyle.backgroundPosition,
          coordinateError: Math.abs(parseFloat(digitStyle.backgroundPositionX) + parseFloat(getComputedStyle(element).getPropertyValue("--tool-shimmer-offset")) - parseFloat(titleStyle.backgroundPositionX)),
          titleAnimation: titleStyle.animationName, independentAnimations: element.getAnimations().length,
          sharedWidth: Math.abs(parseFloat(digitStyle.backgroundSize) - 2 * title.getBoundingClientRect().width) };
      });
      assert.ok(typeof shimmerBefore.time === "number" && shimmerBefore.background.includes("linear-gradient"), "digits have an active shimmer: " + JSON.stringify(shimmerBefore));
      assert.ok(shimmerBefore.coordinateError < 1, "digits sample the title sweep at their actual horizontal coordinate");
      assert.ok(shimmerBefore.sharedWidth < 1, "digits use the full title gradient width, not their own small gradient");
      assert.equal(shimmerBefore.independentAnimations, 0, "no independent numeric shimmer clock");
      await page.evaluate(() => window.motionSocket.burst(16));
      await page.waitForFunction(() => [...document.querySelectorAll(".toolRollingCountLayers")].some(element => element.getAnimations({ subtree: true }).some(animation => animation.animationName === "toolCountIn")));
      await page.waitForFunction(() => document.querySelector(".toolRollingCountNew")?.textContent === "17");
      assert.equal(await page.locator(".toolBundle").count(), 1, "empty reasoning reservations must not split contiguous tool calls into ×1 groups");
      await page.waitForTimeout(250);
      const shimmerAfter = await counter.evaluate(element => ({ time: element.closest(".toolBundleTitleLabel").getAnimations().find(animation => animation.animationName === "toolTitleShimmer")?.currentTime, phase: getComputedStyle(element.querySelector(".toolCountGlyph")).backgroundPosition }));
      assert.ok(shimmerAfter.time > shimmerBefore.time, "rolling digits must not restart the shimmer clock");
      assert.notEqual(shimmerAfter.phase, shimmerBefore.phase, "shimmer actually moves across digits");
      await page.screenshot({ path: `${evidence}/${engine}-${theme}-${mobile ? "mobile" : "desktop"}.png` });
      // The disclosure chevron and left icon are article pseudo-elements.
      // Their hit targets must work just like clicking the summary text.
      const clickBundleEdge = async side => {
        const heading = bundle.locator(":scope > .messageMeta");
        // Keep the hit target clear of the fixed app header when input/output
        // selection has scrolled the tool's summary above the viewport.
        await heading.evaluate(element => {
          const scroller = element.closest(".messages");
          if (scroller) scroller.scrollTo({ top: 0, behavior: "instant" });
          else element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (parent.scrollTop) parent.scrollTo({ top: 0, behavior: "instant" });
          }
          window.scrollTo({ top: 0, behavior: "instant" });
        });
        const a = await bundle.boundingBox(), h = await heading.boundingBox();
        const point = { x: a.x + (side === "right" ? a.width - 8 : 5), y: h.y + h.height / 2 };
        const hit = await bundle.evaluate((node, point) => { const target = document.elementFromPoint(point.x, point.y); return { inside: node.contains(target), target: target?.className, point }; }, point);
        assert.ok(hit.inside, "physical click must hit the tool row, not sticky browser/app chrome: " + JSON.stringify(hit));
        await page.mouse.click(point.x, point.y);
      };
      await clickBundleEdge("right");
      assert.ok(await bundle.evaluate(node => node.classList.contains("toolExpanded")), "right chevron opens on the first click");
      await page.evaluate(() => window.motionSocket.summary("先到的思考摘要，继续增量，完成", true));
      await page.getByText("先到的思考摘要，继续增量，完成", { exact: true }).waitFor();
      assert.equal(await page.locator(".reasoningSummaryPreview").count(), 1, "tool arrivals and completion keep the same reasoning identity");
      await bundle.evaluate(node => { node.__qaSameBundle = true; });
      await page.evaluate(() => window.motionSocket.emit({ type: "live.reasoning", data: { itemId: "blank-reason-1", threadId: "motion-thread", turnId: "motion-turn", text: "稍晚到达的公开摘要", completed: true, sequence: 3, startedAt: "2020-01-01T00:00:00Z", updatedAt: new Date().toISOString() } }));
      await page.getByText("稍晚到达的公开摘要", { exact: true }).waitFor();
      assert.ok(await bundle.evaluate(node => node.__qaSameBundle && node.classList.contains("toolExpanded")), "filling an earlier reasoning placeholder must preserve the mounted bundle and its expanded state");
      const entry = bundle.locator(".toolBundleEntry").first();
      if (!(await entry.evaluate(node => node.classList.contains("toolExpanded")))) await entry.locator(":scope > .messageMeta").click();
      const input = entry.locator(".toolBundleInput");
      await input.waitFor({ state: "visible" });
      await page.waitForTimeout(450);
      // Real pointer selection emits a click on mouseup: it must not collapse
      // either the nested entry or its outer tool bundle.
      const inputBox = await input.boundingBox();
      await page.mouse.move(inputBox.x + 12, inputBox.y + inputBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(inputBox.x + 54, inputBox.y + inputBox.height / 2, { steps: 8 });
      await page.mouse.up();
      assert.ok(await page.evaluate(() => Boolean(getSelection()?.toString())), "tool text remains selectable");
      assert.ok(await entry.evaluate(node => node.classList.contains("toolExpanded")));
      assert.ok(await bundle.evaluate(node => node.classList.contains("toolExpanded")));
      // Dismiss the separate selection-ask floating button before physically
      // clicking beneath it; it is not part of the tool disclosure hit area.
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await page.locator(".selectionAskButton").waitFor({ state: "hidden", timeout: 2000 });
      await clickBundleEdge("left");
      assert.equal(await bundle.evaluate(node => node.classList.contains("toolExpanded")), false, "left icon still collapses after selecting output");
      await clickBundleEdge("right");
      assert.ok(await bundle.evaluate(node => node.classList.contains("toolExpanded")), "right chevron reopens on first click");
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await entry.locator(":scope > .messageMeta").click();
      assert.equal(await entry.evaluate(node => node.classList.contains("toolExpanded")), false, "summary alone toggles");
      await page.evaluate(() => {
        window.qaEntryAnimations = [];
        const animate = Element.prototype.animate;
        Element.prototype.animate = function(frames, options) {
          if(this.matches('.toolBundleEntry')) window.qaEntryAnimations.push({key:this.dataset.toolEntryKey,options});
          return animate.call(this,frames,options);
        };
        window.motionSocket.burst(3, true);
      });
      await bundle.locator('.toolBundleEntry[data-tool-entry-key="tool-20"]').waitFor();
      const arrivals=await page.evaluate(()=>window.qaEntryAnimations);
      assert.deepEqual(arrivals.map(item=>item.key),['tool-18','tool-19','tool-20'],'only newly snapshot-delivered rows animate');
      assert.ok(arrivals.every(item=>item.options.duration===220&&item.options.delay<=160),'bounded, staggered entry motion');
      await page.evaluate(()=>window.motionSocket.emit({type:'live.state',data:window.motionSocket.snapshot()}));
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(()=>window.qaEntryAnimations.length),3,'repeated snapshots do not replay existing rows');
      const editor = page.locator(".conversation > .composer .composerRichInput");
      await editor.fill("这是输入区域宽度测试。".repeat(12));
      const composerLayout = await page.evaluate(() => {
        const root = document.querySelector(".conversation > .composer"), body = root.querySelector(".composerBody"), editor = root.querySelector(".composerRichEditor"), actions = root.querySelector(".composerSendActions"), tools = root.querySelector(".composerTools");
        const a = editor.getBoundingClientRect(), b = actions.getBoundingClientRect(), c = body.getBoundingClientRect(), d = tools.getBoundingClientRect();
        return { editorRight: a.right, bodyRight: c.right, editorBottom: a.bottom, actionsTop: b.top, actionsBottom: b.bottom, toolsBottom: d.bottom, actionsParentIsBody: actions.closest('.composerBody') === body && actions.parentElement === tools.parentElement && actions.parentElement.classList.contains('composerControlRow') };
      });
      assert.ok(composerLayout.actionsParentIsBody);
      const plusPosition = await page.evaluate(() => { const tools=document.querySelector('.composerControlRow .composerTools').getBoundingClientRect(),plus=document.querySelector('.composerControlRow .v2ComposerPlus').getBoundingClientRect();return {toolsLeft:tools.left,plusLeft:plus.left}; });
      assert.ok(Math.abs(plusPosition.toolsLeft-plusPosition.plusLeft)<2,'plus stays at the left edge regardless of right-aligned controls');
      assert.ok(Math.abs(composerLayout.editorRight - composerLayout.bodyRight) < 2, "editor uses the space above mic/send");
      assert.ok(composerLayout.editorBottom <= composerLayout.actionsTop + 2, "editor cannot overlap controls");
      assert.ok(Math.abs(composerLayout.actionsBottom - composerLayout.toolsBottom) < 2, "all bottom controls align");
      await editor.evaluate(node => node.editor.commands.setContent(("## 当日未完成线上办公日报\n\n10 月 23 日 23:45 截止\n\n当日已完成\n\n" + "中英文混排 LongUnbrokenToken".repeat(35) + "\n\n").repeat(15), {contentType:"markdown"}));
      await page.waitForTimeout(500);
      const longComposerLayout = await page.evaluate(() => {
        const root=document.querySelector('.conversation > .composer'),body=root.querySelector('.composerBody'),shell=root.querySelector('.composerRichEditor'),actions=root.querySelector('.composerSendActions');
        const r=root.getBoundingClientRect(),b=body.getBoundingClientRect(),s=shell.getBoundingClientRect(),a=actions.getBoundingClientRect();
        return {rootBottom:r.bottom,bodyBottom:b.bottom,editorBottom:s.bottom,actionsTop:a.top,actionsBottom:a.bottom,editorHeight:s.height,scrollHeight:shell.scrollHeight,clientHeight:shell.clientHeight,rootRight:r.right,editorRight:s.right,bodyRight:b.right,overflowY:getComputedStyle(shell).overflowY};
      });
      assert.ok(longComposerLayout.editorBottom<=longComposerLayout.actionsTop+2,'long draft cannot overlap controls: '+JSON.stringify(longComposerLayout));
      assert.ok(longComposerLayout.actionsBottom<=longComposerLayout.rootBottom+1,'controls stay inside the glass even with a legacy 520px preference: '+JSON.stringify(longComposerLayout));
      assert.ok(longComposerLayout.editorRight<=longComposerLayout.rootRight+1,'long words stay within the composer');
      assert.ok(longComposerLayout.scrollHeight>longComposerLayout.clientHeight&&longComposerLayout.overflowY==='auto','long text scrolls in the editor');
      const scrollEditor=page.locator('.conversation > .composer .composerRichEditor');
      await scrollEditor.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll'));});
      await page.waitForFunction(()=>document.querySelector('.conversation > .composer .composerRichEditor')?.classList.contains('hasDraftBelow'));
      assert.ok(await scrollEditor.evaluate(node=>getComputedStyle(node).maskImage.includes('linear-gradient')),'long draft fades at the viewport edge');
      assert.equal(await page.locator('.conversation > .composer').evaluate(node=>getComputedStyle(node).maskImage),'none','glass and footer do not fade');
      await scrollEditor.evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event('scroll'));});
      await page.waitForFunction(()=>!document.querySelector('.conversation > .composer .composerRichEditor')?.classList.contains('hasDraftBelow'));
      assert.equal(await scrollEditor.evaluate(node=>getComputedStyle(node).maskImage),'none','the last line remains fully readable at the bottom');
      await scrollEditor.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll'));});
      const crowdedComposerLayouts=[];
      for(const attachments of [false,true]){
        await page.evaluate(attachments=>{
          document.querySelectorAll('.qaComposerHeader,.qaComposerAttachment').forEach(node=>node.remove());
          const root=document.querySelector('.conversation > .composer'),body=root.querySelector('.composerBody');
          const header=document.createElement('div');header.className='qaComposerHeader';header.style.cssText='height:64px;min-height:64px;display:flex;align-items:center;font-size:13px';header.textContent='持续目标 · 执行中　子代理记录 · 35';root.insertBefore(header,body);
          if(attachments){const files=document.createElement('div');files.className='uploadedFileList qaComposerAttachment';files.style.cssText='height:48px;overflow:auto';files.textContent='附加文件.pdf　图片.png';body.insertBefore(files,body.querySelector('.composerRichEditor'));}
        },attachments);
        await page.waitForTimeout(500);
        const bounds=await page.evaluate(()=>{
          const root=document.querySelector('.conversation > .composer'),editor=root.querySelector('.composerRichEditor'),row=root.querySelector('.composerControlRow'),buttons=[...row.querySelectorAll('button')].filter(node=>node.getBoundingClientRect().width>0);
          const r=root.getBoundingClientRect(),e=editor.getBoundingClientRect(),c=row.getBoundingClientRect();
          return {outerBottom:r.bottom,rowBottom:c.bottom,rowTop:c.top,editorBottom:e.bottom,editorHeight:e.height,allButtonsInside:buttons.every(button=>{const b=button.getBoundingClientRect();return b.bottom<=r.bottom-2&&b.left>=r.left&&b.right<=r.right;}),inlineScroll:editor.scrollHeight>editor.clientHeight};
        });
        assert.ok(bounds.allButtonsInside&&bounds.rowBottom<=bounds.outerBottom-2&&bounds.editorBottom<=bounds.rowTop+1,'headers and attachments cannot push the control row out: '+JSON.stringify(bounds));
        assert.ok(bounds.editorHeight>=28&&bounds.inlineScroll,'a usable editor remains and scrolls, without truncating the draft');
        crowdedComposerLayouts.push({attachments,...bounds});
        await page.screenshot({path:`${evidence}/composer-crowded-${engine}-${theme}-${mobile?'mobile':'desktop'}-${attachments?'files':'header'}.png`});
      }
      await page.evaluate(()=>document.querySelectorAll('.qaComposerHeader,.qaComposerAttachment').forEach(node=>node.remove()));
      await page.screenshot({path:`${evidence}/composer-long-${engine}-${theme}-${mobile?'mobile':'desktop'}.png`});
      await editor.fill('恢复短草稿');
      await page.waitForTimeout(500);
      const glassMaterial=await page.evaluate(()=>{
        const root=document.querySelector('.conversation > .composer'),layer=root.querySelector('.composerOriginalLayer'),warp=layer?.querySelector('.glass__warp');
        return {enabled:root.classList.contains('composerLiquidGlass'),quality:root.dataset.glassOptics,
          decorations:root.querySelectorAll('.composerOriginalLayer').length,rimPointerEvents:getComputedStyle(layer).pointerEvents,
          engine:root.dataset.glassEngine,nativeFilter:getComputedStyle(root,'::before').backdropFilter,
          contentFilter:getComputedStyle(root.querySelector('.composerRichInput')).filter,
          controlColor:getComputedStyle(root.querySelector('.groupedModelPicker > button')).color,
          controlBackground:getComputedStyle(root.querySelector('.groupedModelPicker > button')).backgroundColor,
          controlBorder:getComputedStyle(root.querySelector('.groupedModelPicker > button')).borderTopWidth,
          nativeFilterWidth:layer.querySelector('filter')?.getAttribute('width'),
          buttonBackdrops:[...root.querySelectorAll('.composerControlRow button')].filter(node=>node.getBoundingClientRect().width).map(node=>getComputedStyle(node).backdropFilter)};
      });
      assert.ok(glassMaterial.enabled&&glassMaterial.decorations===1&&glassMaterial.rimPointerEvents==='none','one non-interactive glass skin');
      assert.equal(glassMaterial.contentFilter,'none','editor glyphs are never refracted or blurred');
      assert.ok(glassMaterial.buttonBackdrops.every(value=>value==='none'),'no independent per-button backdrop renderers');
      assert.equal(glassMaterial.quality,'original','Chromium uses the original effect on desktop and small screens without an FPS downgrade');
      assert.equal(glassMaterial.engine,'liquid-glass-react@1.1.1');
      assert.equal(glassMaterial.nativeFilterWidth,'170%','production retains the original full optical filter, not the crop experiment');
      assert.equal(glassMaterial.controlBorder,'0px','no thick static control border');
      if(theme==='light') {
        assert.equal(glassMaterial.controlColor,'rgb(59, 66, 57)','light controls use the same text colour as the topbar');
        assert.equal(glassMaterial.controlBackground,'rgb(238, 240, 236)','light controls use the same pale background as the topbar');
      }
      assert.ok(glassMaterial.nativeFilter.includes('url(')&&glassMaterial.nativeFilter.includes('blur(12px)'),'actual backdrop samples are refracted AND blurred');
      const bounds=await page.locator('.conversation > .composer').boundingBox();
      const originalTransform=await page.locator('.composerOriginalPane').evaluate(node=>getComputedStyle(node).transform);
      await page.mouse.move(bounds.x+bounds.width*.3,bounds.y+10);
      await page.waitForTimeout(200);
      assert.equal(originalTransform,'none');
      assert.equal(await page.locator('.composerOriginalPane').evaluate(node=>getComputedStyle(node).transform),'none','hover does not stretch or detach the glass');
      const glassPerformance=await page.evaluate(async()=>{
        const root=document.querySelector('.conversation > .composer'),layer=root.querySelector('.composerOriginalLayer');
        const frames=()=>new Promise(resolve=>{
          let start=0,last=0;const times=[];
          const timer=setInterval(()=>{root.querySelector('.composerRichInput').dispatchEvent(new InputEvent('input',{bubbles:true}));},50);
          const loop=now=>{start||=now;if(last)times.push(now-last);last=now;if(now-start<1200){requestAnimationFrame(loop);return;}clearInterval(timer);times.sort((a,b)=>a-b);resolve({fps:times.length*1000/(now-start),p95Ms:times[Math.floor(times.length*.95)]});};
          requestAnimationFrame(loop);
        });
        root.classList.remove('composerLiquidGlass');layer.style.visibility='hidden';
        const baseline=await frames();
        root.classList.add('composerLiquidGlass');layer.style.visibility='';
        const material=await frames();
        return {baseline,material,quality:root.dataset.glassOptics};
      });
      console.log(JSON.stringify({glassCheck:{engine,theme,mobile,glassMaterial,glassPerformance}}));
      await page.locator(".quotaButton").click();
      await page.locator('[data-account-id="provider:ark"]').click();
      await page.getByRole("tabpanel", { name: "Ark quota" }).waitFor();
      const widths = await page.locator(".accountPoolTab").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
      assert.equal(widths.length, 6);
      assert.ok(Math.max(...widths) - Math.min(...widths) < 1, "GPT/Ark/MiMo share equal-width cells");
      assert.ok((await page.locator(".providerQuotaDetails").innerText()).includes("80.8%"));
      assert.ok((await page.locator(".providerQuotaDetails").innerText()).includes("/ 7天，已用"));
      await page.screenshot({ path: `${evidence}/quota-composer-${engine}-${theme}-${mobile ? "mobile" : "desktop"}.png` });
      await page.locator('[data-account-id="provider:mimo"]').click();
      assert.ok((await page.locator(".providerQuotaDetails").innerText()).includes("授权"));
      await bundle.evaluate(element => element.classList.remove("toolBundleShimmering"));
      assert.equal(await counter.evaluate(element => element.getAnimations().length), 0, "shimmer stops with the cluster, not an individual tool");
      await bundle.evaluate(element => element.classList.add("toolBundleShimmering"));
      await page.locator(".quotaButton").click();
      await page.evaluate(() => window.motionSocket.emit({ type: "codex.notification", data: { method: "turn/completed", params: { threadId: "motion-thread", turn: { id: "motion-turn", status: "failed", error: { httpStatusCode: 429, message: "429 Too Many Requests; request id: fixture-429" } } } } }));
      const banner = page.getByRole("alert", { name: "模型请求失败" });
      await banner.waitFor({ state: "visible" });
      assert.equal(await page.locator(".providerFailureNotice").count(), 0, "model failures are no longer floating dialogs");
      assert.ok(await banner.evaluate(node => node.parentElement.classList.contains("threadNoticeStack")), "errors live in the same header notice stack as 502");
      const errorLayout = await banner.evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, bottom: r.bottom, position: getComputedStyle(node).position, color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, animation: getComputedStyle(node).animationName }; });
      assert.notEqual(errorLayout.position, "fixed");
      assert.ok(errorLayout.width > (mobile ? 340 : 700), "error is a full-width strip, not a centered card");
      assert.equal(errorLayout.animation, "providerErrorBannerIn");
      await banner.locator("summary").click();
      assert.ok((await banner.innerText()).includes("fixture-429"), "safe error details remain available");
      await page.screenshot({ path: `${evidence}/error-banner-${engine}-${theme}-${mobile ? "mobile" : "desktop"}.png` });
      await banner.getByRole("button", { name: "关闭模型错误提示" }).click();
      await page.waitForFunction(() => {const node=document.querySelector(".providerErrorBanner");return !node||node.classList.contains("uiClosing");});
      await banner.waitFor({ state: "detached" });
      await page.evaluate(() => window.motionSocket.emit({ type: "turn.recovery", data: { threadId: "motion-thread", error: { code: "rate_limited", message: "上游暂时限频", originalMessage: "RateLimitExceeded.EndpointTPMExceeded", retryable: true, at: new Date().toISOString() }, job: { status: "waiting", attempts: 0, maxAttempts: 5, nextRetryAt: Date.now() + 20000 } } }));
      const recoveryBanner = page.getByRole("alert", { name: "本轮模型状态" });
      await recoveryBanner.waitFor({ state: "visible" });
      assert.ok(await recoveryBanner.evaluate(node => node.parentElement.classList.contains("threadNoticeStack")));
      assert.equal(await page.locator(".turnRecoveryDock").count(), 0, "automatic retry status is no longer a centered overlay either");
      await recoveryBanner.getByRole("button", { name: "立即重试", exact: true }).waitFor();
      await recoveryBanner.getByRole("button", { name: "取消自动重试", exact: true }).waitFor();
      if (mobile) assert.ok(await recoveryBanner.locator(".errorBannerMessage").evaluate(node => node.getBoundingClientRect().width > 260), "retry actions must not squeeze mobile error text into a narrow column");
      await page.screenshot({ path: `${evidence}/recovery-banner-${engine}-${theme}-${mobile ? "mobile" : "desktop"}.png` });
      await recoveryBanner.getByRole("button", { name: "关闭模型状态提示" }).click();
      await recoveryBanner.waitFor({ state: "detached" });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(()=>document.querySelector('.conversation > .composer')?.dataset.glassOptics==='reduced-motion');
      assert.equal(await counter.evaluate(element => element.getAnimations().length), 0);
      assert.equal(await counter.locator(".toolCountGlyph").last().evaluate(element => getComputedStyle(element).backgroundImage), "none");
      fixtureCompleted=true;
      await page.evaluate(()=>{
        const socket=window.motionSocket, snapshot=socket.snapshot.bind(socket);
        socket.snapshot=()=>({...snapshot(),activeTurns:[]});
        socket.emit({type:'codex.notification',data:{method:'turn/completed',params:{threadId:'motion-thread',turn:{id:'motion-turn',status:'completed'}}}});
      });
      const modelTrigger=page.locator('.conversation > .composer .groupedModelPicker > .polishedSelectTrigger');
      await modelTrigger.click();
      const modelMenu=page.locator('.conversation > .composer .groupedModelMenu');
      await modelMenu.waitFor({state:'visible'});
      await page.waitForTimeout(400);
      assert.ok(await modelMenu.evaluate(node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.left+r.width/2,r.top+Math.min(20,r.height/2)));}),'model popover is not clipped by the new footer layout');
      await modelTrigger.click();
      await modelMenu.waitFor({state:'detached'});
      const plusTrigger=page.locator('.conversation > .composer .v2ComposerPlus');
      await plusTrigger.click();
      const plusMenu=page.locator('#v2PlusMenu');
      await plusMenu.waitFor({state:'visible'});
      assert.ok(await plusMenu.evaluate(node=>getComputedStyle(node).backdropFilter.includes('blur(20px)')),'plus actions retain their own blurred glass backing');
      await plusTrigger.click();
      await plusMenu.waitFor({state:'hidden'});
      fixtureCompleted=false;
      includeReasoningHistory = true;
      await page.reload();
      // The fixture uses non-UUID IDs; explicitly reselect its sidebar row
      // instead of relying on the production route's UUID restoration rules.
      await page.locator('.threadRow[data-thread-id="motion-thread"] .threadSelectButton').evaluate(node => node.click());
      await page.getByText("先到的思考摘要，继续增量，完成", { exact: true }).waitFor({ timeout: 5000 }).catch(async error => {
        console.error(JSON.stringify({ fixtureReload: true, url: page.url(), summaries: await page.locator('.reasoningSummaryPreview').allTextContents(), snapshot: await page.evaluate(() => window.motionSocket?.reason), body: (await page.locator('.conversation').innerText()).slice(0, 1800) }));
        throw error;
      });
      assert.equal(await page.locator(".reasoningSummaryPreview").count(), 1, "native history and reconnect snapshot are one reasoning item after full page reload");
      assert.ok(await page.locator(".reasoningSummaryPreview").evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector(".kind-agent")) & Node.DOCUMENT_POSITION_FOLLOWING)), "reasoning stays before its following answer");
      results.push({ engine, theme, mobile, alignment, reasoningBeforeToolAndHistory: true, reasoningReconnectDeduplicated: true, reasoningCompletionDeduplicated: true, reasoningPageReloadDeduplicated: true, providerErrorAsHeaderBanner: true, retryStatusAsHeaderBanner: true, errorLayout, completedDelayedToolFadesIn: true, actualCountRollAnimation: true, sharedSweepCoordinateError: shimmerBefore.coordinateError, noIndependentDigitShimmer: true, shimmerAndFlipCoexist: true, shimmerPhasePreserved: true, shimmerStopsWithCluster: true, reducedMotion: true, toolTextSelectionPreserved: true, equalQuotaWidths: widths, composerLayout, longComposerLayout, crowdedComposerLayouts, glassMaterial, glassPerformance });
      await page.close();
    }
  } finally { await browser.close(); }
}
assert.deepEqual(errors, []);
await fs.writeFile(`${evidence}/results.json`, JSON.stringify({ results, errors }, null, 2));
console.log(JSON.stringify({ results, errors }));
