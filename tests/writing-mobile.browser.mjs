// Read-only visual check of the isolated native DOCX fixture at phone width.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
const username = process.env.DOCUMENT_QA_USER || "qaUser";
const url = process.env.DOCUMENT_QA_URL || "http://127.0.0.1:4575";
const projectId = process.env.DOCUMENT_QA_PROJECT;
const texOnly = process.env.DOCUMENT_QA_FILE === "paper.tex";
if (!process.env.DOCUMENT_QA_PASSWORD) throw new Error("Authorized QA password required.");
const browser = await chromium.launch({ executablePath: process.env.DOCUMENT_QA_CHROMIUM || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.request.post(`${url}/api/auth/login`, { data: { username, password: process.env.DOCUMENT_QA_PASSWORD } });
  await context.addInitScript(({ theme, username }) => { localStorage.setItem("codex-web-user-id", username); localStorage.setItem("codex-web-color-theme", theme); }, { theme: texOnly ? "light" : "dark", username });
  const page = await context.newPage();
  await page.goto(url);
  await page.locator(`.v2WorkspaceGroup[data-project-id="${projectId}"] .projectNewThreadButton`).click();
  await expect(page.locator(".projectTitle p")).toContainText("document-workbench-qa-");
  await page.setViewportSize({ width: 390, height: 844 });
  const collapse = page.getByRole("button", { name: "折叠侧边栏", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await page.locator(".v2ComposerPlus").click();
  await page.locator('#v2PlusMenu [data-action="writing"]').click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("treeitem", { name: texOnly ? /paper\.tex/ : /word-fixture\.docx/ }).click();
  if (texOnly) {
    await expect(page.locator(".writingCodeEditor .cm-content")).toContainText("\\documentclass{article}");
    await expect(page.locator(".writingEditorPane")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "/tmp/writing-mobile-light-tex-final.png" });
    console.log("PASS: public mobile light TeX document rendered; /tmp/writing-mobile-light-tex-final.png");
  } else {
  await page.locator(".writingDocxEditor .presentation-editor__viewport").waitFor({ timeout: 90000 });
  const cell = page.locator(".writingDocxEditor .superdoc-page").getByText("Keep this cell", { exact: true }).first();
  await expect(cell).toBeVisible();
  await expect(cell).toBeInViewport();
  await expect(cell).toHaveCSS("color", "rgb(32, 32, 32)");
  await page.waitForTimeout(500);
  for (const text of ["Styled DOCX fixture", "Keep this cell", "Header preservation marker", "Edited in native DOCX."]) {
    const nodes = page.locator(".writingDocxEditor").getByText(text, { exact: false });
    console.log(JSON.stringify({ text, nodes: await nodes.evaluateAll(elements => elements.map(e => ({ tag: e.tagName, className: e.className, text: e.textContent?.slice(0, 140), rect: e.getBoundingClientRect().toJSON(), opacity: getComputedStyle(e).opacity, color: getComputedStyle(e).color, parent: e.parentElement?.className }))) }));
  }
  const cdp = await context.newCDPSession(page);
  const capture = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 390, height: 844, scale: 1 } });
  await fs.writeFile("/tmp/writing-mobile-docx-final.png", Buffer.from(capture.data, "base64"));
  console.log("Captured /tmp/writing-mobile-docx-final.png");
  }
} finally { await browser.close(); }
