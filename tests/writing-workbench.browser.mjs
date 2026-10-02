import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

const baseUrl = process.env.DOCUMENT_QA_URL || "http://127.0.0.1:4590";
const username = process.env.DOCUMENT_QA_USER || "qaUser";
if (!process.env.DOCUMENT_QA_PASSWORD) throw new Error("Set DOCUMENT_QA_PASSWORD for an authorized test user.");
const root = process.env.DOCUMENT_QA_ROOT || await fs.mkdtemp(path.join(process.env.DOCUMENT_QA_ROOT || process.cwd(), "document-workbench-qa-"));
const screenshots = await fs.mkdtemp("/tmp/codex-writing-visual-");
// Exercise native OOXML round-tripping with real document structures, not just
// a paragraph-only fixture. This writes only inside the explicitly scoped QA root.
execFileSync("python3", ["-c", String.raw`
from io import BytesIO
from pathlib import Path
import sys
from docx import Document
from docx.oxml import OxmlElement
from docx.shared import Inches, RGBColor
from PIL import Image

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
doc = Document()
doc.sections[0].header.paragraphs[0].text = "Header preservation marker"
heading = doc.add_paragraph(style="Title")
heading.add_run("Styled DOCX fixture")
target = doc.add_paragraph()
run = target.add_run("Native DOCX styled target.")
run.bold = True
run.font.color.rgb = RGBColor(0x22, 0x66, 0x99)
table = doc.add_table(rows=1, cols=2)
table.cell(0, 0).text = "Table label"
table.cell(0, 1).text = "Keep this cell"
math = OxmlElement("m:oMath")
math_run = OxmlElement("m:r")
math_text = OxmlElement("m:t")
math_text.text = "E = mc²"
math_run.append(math_text)
math.append(math_run)
target._p.append(math)
image = Image.new("RGB", (12, 12), (220, 50, 50))
buffer = BytesIO()
image.save(buffer, format="PNG")
doc.add_picture(BytesIO(buffer.getvalue()), width=Inches(0.2))
doc.save(root / "word-fixture.docx")
`, root], { stdio: "inherit" });
const browser = await chromium.launch({ executablePath: process.env.DOCUMENT_QA_CHROMIUM || undefined, headless: process.env.DOCUMENT_QA_HEADLESS !== "0", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let activePage;
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const login = await context.request.post(`${baseUrl}/api/auth/login`, { data: { username, password: process.env.DOCUMENT_QA_PASSWORD } });
  assert.equal(login.status(), 200, "authorized test user login");
  const projectResponse = await context.request.post(`${baseUrl}/api/projects`, { headers: { "x-codex-web-user-id": username }, data: { name: "写作工作台验收", rootPath: root, defaultModel: "gpt-6-luna", defaultReasoningEffort: "medium" } });
  assert.ok(projectResponse.ok(), await projectResponse.text());
  const project = (await projectResponse.json()).data;
  console.log(JSON.stringify({ root, projectId: project.id, screenshots }));
  await context.addInitScript(({ username, id }) => { localStorage.setItem("codex-web-user-id", username); localStorage.setItem(`codex-v2-project-${username}`, id); localStorage.setItem("codex-web-color-theme", "dark"); }, { username, id: project.id });
  const tex = String.raw`\documentclass{article}
\begin{document}
\section{Writing workbench}
This selected sentence is the precise editing target. Keep the equation intact:
\[ E = mc^2. \]
\end{document}
`;
  const existing = await context.request.get(`${baseUrl}/api/projects/${project.id}/documents/open?path=paper.tex`, { headers: { "x-codex-web-user-id": username } });
  const prior = existing.ok() ? (await existing.json()).data : null;
  const save = await context.request.put(`${baseUrl}/api/projects/${project.id}/documents/save`, { headers: { "x-codex-web-user-id": username }, data: { path: "paper.tex", baseVersion: prior?.version ?? null, create: !prior, content: tex } });
  assert.ok(save.ok(), await save.text());
  const page = await context.newPage();
  activePage = page;
  const errors = [];
  let wordSourceReads = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/documents/raw") && url.searchParams.get("path") === "word-fixture.docx") wordSourceReads++;
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { console.log(`Browser dialog: ${dialog.type()} ${dialog.message()}`); void dialog.accept(); });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".v2ComposerPlus").waitFor({ state: "visible", timeout: 60000 });
  const group = page.locator(`.v2WorkspaceGroup[data-project-id="${project.id}"]`);
  await group.waitFor({ state: "visible", timeout: 60000 });
  await group.locator('.projectNewThreadButton').click();
  await expect(page.locator(".projectTitle p")).toHaveText(root, { timeout: 60000 });
  await page.locator(".v2ComposerPlus").click();
  await page.locator('#v2PlusMenu [data-action="writing"]').click();
  await page.locator(".writingWorkbench").waitFor({ state: "visible", timeout: 60000 });
  await page.getByRole("treeitem", { name: /paper\.tex/ }).click();
  await page.locator(".writingCodeEditor .cm-content").waitFor({ timeout: 60000 });
  await page.screenshot({ path: path.join(screenshots, "desktop-dark-editor.png") });
  await page.getByRole("button", { name: "编译", exact: true }).click();
  await page.locator(".writingPdfCanvasWrap canvas").waitFor({ timeout: 120000 });
  await page.locator(".writingPdfTextLayer span").first().waitFor({ timeout: 30000 });
  const pdfPage = page.locator(".writingPdfCanvasWrap").first();
  const heightBeforeZoom = await pdfPage.evaluate(element => element.getBoundingClientRect().height);
  await page.getByRole("button", { name: "放大 PDF", exact: true }).click();
  await expect.poll(() => pdfPage.evaluate(element => element.getBoundingClientRect().height), { timeout: 15000 }).toBeGreaterThan(heightBeforeZoom);
  const pdfViewport = page.locator(".writingPdfViewer");
  await expect.poll(() => pdfViewport.evaluate(element => element.scrollWidth - element.clientWidth), { timeout: 15000 }).toBeGreaterThan(0);
  await pdfViewport.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  assert.ok(await pdfPage.evaluate(element => element.getBoundingClientRect().right > 0), "zoomed PDF remains horizontally scrollable instead of being clipped");
  await pdfViewport.evaluate(element => { element.scrollLeft = 0; });
  await page.getByRole("button", { name: "缩小 PDF", exact: true }).click();
  console.log("PASS: real PDF compile and text layer");
  await page.screenshot({ path: path.join(screenshots, "desktop-dark-pdf.png") });
  const selectedPdfText = await page.locator(".writingPdfTextLayer").first().evaluate(element => {
    const span = [...element.querySelectorAll("span")].find(node => node.textContent.includes("Writing workbench"));
    if (!span) return false;
    const text = span.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) return false;
    const from = text.textContent.indexOf("Writing workbench");
    const range = document.createRange(); range.setStart(text, from); range.setEnd(text, from + "Writing workbench".length);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const rect = span.getBoundingClientRect();
    span.closest(".writingPdfPage").dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    return true;
  });
  assert.ok(selectedPdfText, "PDF text layer supports real selection");
  await page.locator(".composerDocumentReference").waitFor({ state: "visible", timeout: 30000 });
  assert.match(await page.locator(".composerDocumentReference").first().innerText(), /paper\.tex/i, "PDF selection resolves through SyncTeX to source");
  console.log("PASS: selected PDF text resolves through SyncTeX");
  await page.locator('.v2ThemeToggle').click();
  await page.screenshot({ path: path.join(screenshots, "desktop-light-pdf.png") });
  const selectText = await page.locator(".writingCodeEditor .cm-content").evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = node.textContent.indexOf("This selected sentence");
      if (start < 0) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + "This selected sentence".length);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return true;
    }
    return false;
  });
  assert.ok(selectText);
  // CodeMirror selections are model selections; use keyboard to exercise the real editor.
  await page.locator(".writingCodeEditor .cm-content").click();
  await page.keyboard.press("Control+Home");
  for (let line = 0; line < 4; line++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.getByRole("button", { name: "引用选区", exact: true }).click();
  await page.locator(".composerDocumentReference").waitFor({ state: "visible" });
  console.log("PASS: source selection expands existing Codex pane");
  await page.screenshot({ path: path.join(screenshots, "desktop-light-three-pane.png") });
  await page.getByRole("button", { name: "隐藏聊天", exact: true }).click();
  await page.getByRole("button", { name: "新建 DOCX", exact: true }).click();
  await page.getByText("原生 DOCX 编辑", { exact: true }).waitFor({ state: "visible", timeout: 60000 });
  const newDocxName = await page.locator(".writingPaneTitle > span").first().innerText();
  const newDocx = await context.request.get(`${baseUrl}/api/projects/${project.id}/documents/raw?path=${encodeURIComponent(newDocxName)}`, { headers: { "x-codex-web-user-id": username } });
  assert.ok(newDocx.ok(), await newDocx.text());
  assert.equal((await newDocx.body()).subarray(0, 2).toString(), "PK", "native DOCX template is an exported OOXML package");
  const saveButton = page.getByRole("button", { name: "保存", exact: true });
  if (await saveButton.isEnabled()) {
    await saveButton.click();
    await expect(saveButton).toBeDisabled({ timeout: 60000 });
  }
  await page.getByRole("treeitem", { name: /word-fixture\.docx/ }).click();
  await page.locator(".writingPaneTitle > span").filter({ hasText: "word-fixture.docx" }).waitFor({ state: "visible", timeout: 30000 });
  await page.locator(".writingDocxEditor .superdoc").waitFor({ state: "visible", timeout: 120000 });
  const editable = page.locator('.writingDocxEditor [data-pm-start]').filter({ hasText: "Native DOCX styled target." }).first();
  const targetBounds = await editable.boundingBox();
  assert.ok(targetBounds, "native DOCX text is visibly rendered");
  await page.mouse.click(targetBounds.x + targetBounds.width - 2, targetBounds.y + targetBounds.height / 2);
  await page.keyboard.press("End");
  const wordReadsBeforeSave = wordSourceReads;
  await page.keyboard.type(" Edited in native DOCX.");
  await page.getByText("Native DOCX styled target. Edited in native DOCX.", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await page.keyboard.press("Shift+Home");
  await page.getByRole("button", { name: "引用所选文字", exact: true }).click();
  await page.locator(".composerDocumentReference").last().waitFor({ state: "visible", timeout: 30000 });
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled({ timeout: 30000 });
  console.log("PASS: native DOCX edit, CAS save, and structured selection reference");
  await expect.poll(() => page.locator(".writingDocxEditor").evaluate(host => {
    const viewport = host.querySelector(".presentation-editor__viewport");
    return viewport ? viewport.getBoundingClientRect().width - host.clientWidth : Number.POSITIVE_INFINITY;
  }), { timeout: 15000 }).toBeLessThanOrEqual(0);
  console.log("PASS: newly opened DOCX fits the narrow three-pane layout");
  const zoomLabel = page.locator(".writingDocxEditor .superdoc-toolbar-container .button-label").filter({ hasText: /^\d+%$/ }).first();
  const fittedZoom = await zoomLabel.innerText();
  await zoomLabel.click();
  await page.getByText("150%", { exact: true }).last().click();
  await expect(zoomLabel).toHaveText("150%");
  assert.equal(wordSourceReads, wordReadsBeforeSave, "saving the current native document must not re-import it and reset cursor/zoom");
  await page.waitForTimeout(450);
  await expect(zoomLabel).toHaveText("150%");
  await expect.poll(() => page.locator(".writingDocxEditor .presentation-editor__viewport").evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(1200);
  await zoomLabel.click();
  // The SDK dropdown contains fixed presets, not every computed fit percentage.
  const restoreZoom = [200, 150, 125, 100, 90, 75, 50].find(value => value <= Number.parseInt(fittedZoom, 10)) ?? 50;
  await page.getByText(`${restoreZoom}%`, { exact: true }).last().click();
  console.log("PASS: user-selected native Word zoom is not undone by automatic fit");
  await page.locator(".writingHeading").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(screenshots, "desktop-light-docx-playwright-caret-initial.png"), caret: "initial" });
  const cdp = await context.newCDPSession(page);
  // SuperDoc's separate presentation surface is not flushed by this headless
  // browser's first page.screenshot(); an exact viewport CDP capture flushes it.
  const capture = await cdp.send("Page.captureScreenshot", {
    format: "png", fromSurface: true, captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 1600, height: 1000, scale: 1 }
  });
  await fs.writeFile(path.join(screenshots, "desktop-light-docx.png"), Buffer.from(capture.data, "base64"));
  await cdp.detach();
  const native = await context.request.get(`${baseUrl}/api/projects/${project.id}/documents/open?path=word-fixture.docx`, { headers: { "x-codex-web-user-id": username } });
  assert.ok(native.ok(), await native.text());
  const nativeRaw = await context.request.get(`${baseUrl}/api/projects/${project.id}/documents/raw?path=word-fixture.docx`, { headers: { "x-codex-web-user-id": username } });
  assert.ok(nativeRaw.ok(), await nativeRaw.text());
  const packageFiles = unzipSync(new Uint8Array(await nativeRaw.body()));
  const bodyXml = new TextDecoder().decode(packageFiles["word/document.xml"]);
  const headerXml = new TextDecoder().decode(packageFiles["word/header1.xml"]);
  assert.match(bodyXml, /Table label/); assert.match(bodyXml, /Keep this cell/); assert.match(bodyXml, /<m:oMath\b/);
  assert.match(headerXml, /Header preservation marker/);
  assert.match(bodyXml, /<w:b\b/, "direct paragraph emphasis survives native export");
  assert.match(bodyXml, /<w:color\b/, "direct font color survives native export");
  assert.ok(Object.keys(packageFiles).some(name => name.startsWith("word/media/") && name.endsWith(".png")), "embedded image survives native DOCX export");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "导出 PDF (.pdf)", exact: true })).toBeVisible();
  const exportedPdf = page.waitForEvent("download", { timeout: 90000 });
  await page.getByRole("menuitem", { name: "导出 PDF (.pdf)", exact: true }).click();
  await (await exportedPdf).saveAs(path.join(screenshots, "word-export.pdf"));
  const pdfText = execFileSync("pdftotext", [path.join(screenshots, "word-export.pdf"), "-"], { encoding: "utf8" });
  assert.match(pdfText, /Header preservation marker/);
  assert.match(pdfText, /Keep this cell/);
  assert.match(pdfText.replace(/\s/g, ""), /E=mc[²2]/, "native Word formula survives actual PDF export");
  console.log("PASS: real browser Word-to-PDF download retains table, header, and formula");
  await page.getByRole("treeitem", { name: /paper\.tex/ }).click();
  await page.getByRole("treeitem", { name: /word-fixture\.docx/ }).click();
  await page.locator(".writingDocxEditor .superdoc").waitFor({ state: "visible", timeout: 120000 });
  const visibleReopenedText = page.locator(".writingDocxEditor .superdoc-page").getByText("Styled DOCX fixture", { exact: true }).first();
  await expect(visibleReopenedText).toBeVisible({ timeout: 30000 });
  await expect.poll(() => visibleReopenedText.boundingBox().then(box => box?.width ?? 0)).toBeGreaterThan(40);
  assert.ok(await page.locator(".writingDocxEditor").innerText().then(text => text.includes("Edited in native DOCX.")), "saved native DOCX reopens with the edited text");
  assert.ok(await page.locator(".writingDocxEditor").innerText().then(text => text.includes("Keep this cell")), "table content survives editor export and reopen");
  await page.waitForTimeout(700);
  console.log("PASS: saved DOCX reopens with edited content");
  await page.getByRole("button", { name: "关闭写作", exact: true }).click();
  await page.locator(".writingWorkbench").waitFor({ state: "hidden" });
  assert.ok(await page.locator(".conversation .composerRichInput").isVisible(), "existing composer survives closing");
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebarToggle = page.getByRole("button", { name: "折叠侧边栏", exact: true });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();
  await page.locator(".v2ComposerPlus").click();
  await page.locator('#v2PlusMenu [data-action="writing"]').click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("treeitem", { name: /paper\.tex/ }).click();
  await expect(page.locator(".writingCodeEditor .cm-content")).toContainText("\\documentclass{article}");
  await expect(page.locator(".writingEditorPane")).toHaveCSS("opacity", "1");
  await expect(page.locator(".writingFiles")).toHaveCSS("visibility", "hidden");
  await page.screenshot({ path: path.join(screenshots, "mobile-light-editor.png") });
  const bounds = await page.locator(".writingWorkbench").boundingBox();
  assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= 391, "mobile viewport containment");
  // Use the real theme control, then return the sidebar to the collapsed state.
  await page.getByRole("button", { name: "展开会话列表", exact: true }).click();
  await page.locator(".v2ThemeToggle").click();
  await page.getByRole("button", { name: "折叠侧边栏", exact: true }).click();
  await expect(page.locator(".writingEditorPane")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: path.join(screenshots, "mobile-dark-editor.png") });
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("treeitem", { name: /word-fixture\.docx/ }).click();
  await page.locator(".writingDocxEditor .presentation-editor__viewport").waitFor({ timeout: 120000 });
  await expect.poll(() => page.locator(".writingDocxEditor").evaluate(host => {
    const viewport = host.querySelector(".presentation-editor__viewport");
    return viewport ? viewport.getBoundingClientRect().width - host.clientWidth : Number.POSITIVE_INFINITY;
  }), { timeout: 15000 }).toBeLessThanOrEqual(0);
  const mobileWordCell = page.locator(".writingDocxEditor .superdoc-page").getByText("Keep this cell", { exact: true }).first();
  await expect(mobileWordCell).toBeInViewport();
  await expect(mobileWordCell).toHaveCSS("color", "rgb(32, 32, 32)");
  await expect(page.locator(".writingDocxEditor .superdoc-page").getByText("Header preservation marker", { exact: true }).first()).toHaveCSS("color", "rgb(32, 32, 32)");
  await page.locator(".writingHeading").click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(screenshots, "mobile-dark-docx.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "mobile Word editor does not widen the application");
  console.log("PASS: native Word page and toolbar remain contained on mobile");
  console.log(JSON.stringify({ root, projectId: project.id, screenshots, pageErrors: errors }, null, 2));
  assert.deepEqual(errors, [], "browser runtime errors");
} catch (error) {
  if (activePage) { await activePage.screenshot({ path: path.join(screenshots, "failure.png") }); console.log(JSON.stringify({ error: String(error), body: (await activePage.locator("body").innerText()).slice(0, 3500), screenshots })); }
  throw error;
} finally { await browser.close(); }
