// Read-only, isolated browser check of the real prose plugin and published CSS.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { chromium, webkit } from "playwright";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { rehypeLatinApostrophes } from "../src/proseTypography";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(root, "../output/qa/apostrophes-20261020");
await fs.mkdir(out, { recursive: true });
const index = await fs.readFile(path.join(root, "dist/index.html"), "utf8");
const css = index.match(/href="([^" ]+\.css)"/)![1];
const sample = "中文“We’re cooked”，don’t / l’été / we‘re。‘hello’ 中文’中文。";
const markup = renderToStaticMarkup(<ReactMarkdown rehypePlugins={[rehypeLatinApostrophes]}>{sample + "\n\n**We’re cooked**\n\n行内代码：`We’re cooked 中文‘引用’`\n\n```txt\nWe’re cooked 中文‘引用’\n```"}</ReactMarkdown>);
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"><style>body{margin:0;padding:24px;display:block;background:#fafaf8;color:#292d29}html[data-theme=dark] body{background:#1c1e1c;color:#e9ece7}.qa{font-size:14px;font-weight:420;line-height:1.8;max-width:700px}.qa .baseline{font-family:var(--pool-ui-font)}.qa>div{margin-bottom:24px}</style><body><main class="qa"><div>修改前（相同 Noto 字体）：<div class="baseline">${sample}</div></div><div>修改后：<div class="messageMarkdown">${markup}</div></div></main></body></html>`);
      return;
    }
    const name = new URL(req.url!, "http://localhost").pathname;
    const target = path.resolve(root, "dist", "." + name);
    if (!target.startsWith(path.join(root, "dist") + path.sep)) throw new Error("invalid path");
    res.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "font/woff2");
    res.end(await fs.readFile(target));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const results = [];
try {
  for (const engine of (process.env.CODEX_QA_ENGINES || "chromium").split(",")) {
    const browser = await ({ chromium, webkit }[engine]!).launch({ headless: true });
    try {
      for (const mobile of [true, false]) {
        const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 800 }, isMobile: mobile, hasTouch: mobile });
        await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
        await page.evaluate(async () => {
          await Promise.all([
            document.fonts.load('420 14px "PoolSansUi"', "中We"),
            document.fonts.load('420 14px "PoolSansCommon"', "’"),
          ]);
          await document.fonts.ready;
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        for (const theme of ["light", "dark"]) {
          await page.evaluate(t => {
            document.documentElement.dataset.theme = t;
            document.body.style.setProperty("background", t === "dark" ? "#1c1e1c" : "#fafaf8", "important");
            document.body.style.setProperty("color", t === "dark" ? "#e9ece7" : "#292d29", "important");
            document.documentElement.style.setProperty("background", t === "dark" ? "#1c1e1c" : "#fafaf8", "important");
          }, theme);
          await page.waitForTimeout(120);
          const metrics = await page.evaluate(() => {
            const p = document.querySelector(".messageMarkdown p")!;
            const apostrophe = p.querySelector<HTMLElement>(".latinWordApostrophe")!;
            const width = apostrophe.getBoundingClientRect().width;
            const baseline = document.querySelector(".baseline")!.firstChild!;
            const offset = baseline.textContent!.indexOf("’");
            const range = document.createRange();
            range.setStart(baseline, offset); range.setEnd(baseline, offset + 1);
            const inline = document.querySelector<HTMLElement>("p code .latinWordApostrophe")!;
            const block = document.querySelector<HTMLElement>("pre code .latinWordApostrophe")!;
            const cell = document.createRange();
            cell.setStart(block.parentNode!.firstChild!, 0); cell.setEnd(block.parentNode!.firstChild!, 1);
            return { text: p.textContent, count: p.querySelectorAll(".latinWordApostrophe").length, width, before: range.getBoundingClientRect().width, weight: getComputedStyle(apostrophe).fontWeight, parentWeight: getComputedStyle(p).fontWeight, boldWeight: getComputedStyle(document.querySelector("strong .latinWordApostrophe")!).fontWeight, font: getComputedStyle(apostrophe).fontFamily, codeSpans: document.querySelectorAll("code .latinWordApostrophe").length, inlineWidth: inline.getBoundingClientRect().width, blockWidth: block.getBoundingClientRect().width, blockCellWidth: cell.getBoundingClientRect().width, blockFont: getComputedStyle(block).fontFamily, blockText: block.parentElement!.textContent, overflow: document.documentElement.scrollWidth > innerWidth };
          });
          assert.equal(metrics.text, sample);
          assert.equal(metrics.count, 4);
          // Font fallback differs across engines; require a narrow glyph and
          // an actual improvement, not a fixed ratio to the engine's old font.
          assert(metrics.width < 6 && metrics.width < metrics.before, JSON.stringify(metrics));
          assert.equal(metrics.weight, metrics.parentWeight);
          assert.equal(metrics.boldWeight, "700");
          assert.equal(metrics.codeSpans, 2);
          assert(metrics.inlineWidth < 6);
          assert(metrics.blockWidth < 11 && Math.abs(metrics.blockWidth - metrics.blockCellWidth) < 1.1, JSON.stringify(metrics));
          assert(metrics.blockFont.startsWith("Consolas"));
          assert.equal(metrics.blockText, "We’re cooked 中文‘引用’\n");
          assert(!metrics.overflow);
          await page.screenshot({ path: path.join(out, `${engine}-${mobile ? "mobile" : "desktop"}-${theme}.png`) });
          results.push({ engine, mobile, theme, ...metrics });
        }
        await page.close();
      }
    } finally { await browser.close(); }
  }
  await fs.writeFile(path.join(out, `results-${process.env.CODEX_QA_ENGINES || "chromium"}.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: true, checks: results.length, results, out }));
} finally { server.close(); }
