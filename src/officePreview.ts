import { unzipSync } from "fflate";

const LIMIT = 40 * 1024 * 1024;
export function inspectArchive(data: Uint8Array, listingOnly = false) {
  const entries: { name: string; size: number }[] = [];
  let total = 0;
  unzipSync(data, { filter: entry => {
    total += entry.originalSize;
    entries.push({ name: entry.name, size: entry.originalSize });
    if (entries.length > 2500 || (!listingOnly && (total > LIMIT || entry.originalSize > 12 * 1024 * 1024))) {
      throw new Error("文件展开后过大，已停止预览；请下载到本机打开。");
    }
    return false;
  }});
  return entries;
}
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const xml = (bytes?: Uint8Array) => {
  const source = new TextDecoder().decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error("文档包含不支持的 XML 声明。");
  const result = new DOMParser().parseFromString(source, "application/xml");
  if (result.getElementsByTagName("parsererror").length) throw new Error("文档结构损坏，无法预览。");
  return result;
};
const elements = (root: Document | Element, name: string) => Array.from(root.getElementsByTagNameNS("*", name));
const text = (root: Document | Element, name: string) => elements(root, name).map(el => el.textContent ?? "").join("");
const frame = (body: string, style = "") => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:"><style>html{color-scheme:light}body{margin:0;padding:16px;background:#e7e7e7;color:#222;font:14px/1.6 system-ui,sans-serif}*{box-sizing:border-box}section{background:white;margin:0 auto 20px;padding:28px;max-width:1100px;overflow:auto}h2{font-size:16px}table{border-collapse:collapse;white-space:pre-wrap}td,th{border:1px solid #ddd;padding:5px 9px;min-width:70px}img{max-width:100%;height:auto}p{white-space:pre-wrap}${style}</style></head><body>${body}</body></html>`;

export function renderSpreadsheet(data: Uint8Array) {
  const files = unzipSync(data);
  const strings = files["xl/sharedStrings.xml"] ? elements(xml(files["xl/sharedStrings.xml"]), "si").map(si => text(si, "t")) : [];
  const workbook = xml(files["xl/workbook.xml"]);
  const rels = xml(files["xl/_rels/workbook.xml.rels"]);
  const relationships = new Map(elements(rels, "Relationship").map(el => [el.getAttribute("Id"), el.getAttribute("Target")]));
  let count = 0;
  const body = elements(workbook, "sheet").map(sheet => {
    const relation = relationships.get(sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"));
    const path = relation?.startsWith("/") ? relation.slice(1) : `xl/${relation}`;
    if (!files[path]) return "";
    const rows = elements(xml(files[path]), "row").slice(0, 2000);
    const rendered = rows.map(row => {
      const cells = elements(row, "c");
      let column = 0;
      const html: string[] = [];
      for (const cell of cells) {
        const letters = (cell.getAttribute("r") ?? "").match(/^[A-Z]+/)?.[0] ?? "A";
        const target = Array.from(letters).reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
        if (target > 100 || ++count > 40000) break;
        while (++column < target) html.push("<td></td>");
        const value = text(cell, "v");
        const type = cell.getAttribute("t");
        html.push(`<td>${escape(type === "s" ? strings[Number(value)] ?? "" : type === "inlineStr" ? text(cell, "t") : value)}</td>`);
      }
      return `<tr><th>${escape(row.getAttribute("r") ?? "")}</th>${html.join("")}</tr>`;
    }).join("");
    return `<section><h2>${escape(sheet.getAttribute("name") ?? "工作表")}</h2><table>${rendered}</table></section>`;
  }).join("");
  return frame(`<p>内容预览：每表最多 2000 行、100 列；显示公式的已保存结果，不执行公式。图表、宏和部分样式不参与预览。</p>${body}`);
}

export function renderPresentation(data: Uint8Array) {
  const files = unzipSync(data);
  const presentation = xml(files["ppt/presentation.xml"]);
  const relationships = new Map(elements(xml(files["ppt/_rels/presentation.xml.rels"]), "Relationship").map(el => [el.getAttribute("Id"), el.getAttribute("Target")]));
  const slides = elements(presentation, "sldId").slice(0, 150).map((id, index) => {
    const target = relationships.get(id.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"));
    const path = target?.startsWith("/") ? target.slice(1) : `ppt/${target}`;
    if (!files[path]) return "";
    const slide = xml(files[path]);
    const paragraphs = elements(slide, "p").map(p => `<p>${escape(text(p, "t"))}</p>`).join("");
    const relPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
    const images: string[] = [];
    if (files[relPath]) {
      for (const rel of elements(xml(files[relPath]), "Relationship")) {
        if (!rel.getAttribute("Type")?.endsWith("/image") || rel.getAttribute("TargetMode") === "External") continue;
        const source = rel.getAttribute("Target") ?? "";
        const parts = path.split("/").slice(0, -1);
        for (const part of source.split("/")) { if (part === "..") parts.pop(); else if (part !== ".") parts.push(part); }
        const imagePath = parts.join("/");
        const bytes = files[imagePath];
        if (!bytes || !/\.(png|jpe?g|gif|webp)$/i.test(imagePath)) continue;
        const mime = /\.jpe?g$/i.test(imagePath) ? "jpeg" : imagePath.split(".").at(-1)!.toLowerCase();
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        images.push(`<img alt="幻灯片图片" src="data:image/${mime};base64,${btoa(binary)}">`);
      }
    }
    return `<section><h2>第 ${index + 1} 页</h2>${paragraphs}${images.join("")}</section>`;
  }).join("");
  return frame(`<p>幻灯片内容预览：展示文字和内嵌图片（最多 150 页），不还原动画、母版、图表和精确排版。</p>${slides}`);
}

export function documentFrame(body: string) { return frame(body, "@media(max-width:600px){body{padding:8px}.docx-wrapper{padding:0!important}section.docx{width:100%!important;max-width:100%!important;padding:20px!important;min-height:auto!important}section.docx>header,section.docx>footer{margin:0!important}}" ); }
