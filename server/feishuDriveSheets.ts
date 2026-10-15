import { z } from "zod";
import type { FeishuOperation } from "./feishuOperationTypes.js";

// Official schemas: open.feishu.cn/api/tools/open/api_definition (drive v1,
// sheets v3); sheets v2 data-operation docs; larksuite/node-sdk drive.ts.
// Every operation supports user_access_token; resource permissions still apply.
const token = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const exportToken = token.max(27);
const name = z.string().min(1).refine(s => Buffer.byteLength(s, "utf8") <= 256, "名称不可超过256字节");
const title = z.string().min(1).max(200);
const docType = z.enum(["doc", "sheet", "bitable", "mindnote", "file", "wiki", "docx", "folder", "synced_block", "slides"]);
const filename = z.string().min(1).max(200).refine(s => !/[\\/\x00-\x1f\x7f]/.test(s) && s !== "." && s !== "..", "文件名不能包含路径或控制字符");
const column = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
function dimensions(s: string) {
  const m = /^([A-Za-z0-9_-]{1,200})!([A-Z]{1,3})([1-9]\d{0,6}):([A-Z]{1,3})([1-9]\d{0,6})$/.exec(s);
  if (!m) return null;
  const startColumn = column(m[2]), endColumn = column(m[4]);
  const startRow = Number(m[3]), endRow = Number(m[5]);
  if (startColumn > endColumn || startRow > endRow || endColumn > 13000 || endRow > 5000000) return null;
  return { rows: endRow - startRow + 1, columns: endColumn - startColumn + 1 };
}
// A deliberately bounded subset of official range notation: no whole sheets,
// open-ended columns, title-based selectors, URL fragments, or path traversal.
const range = z.string().max(240).refine(s => {
  const d = dimensions(s);
  return d !== null && d.rows <= 5000 && d.columns <= 100;
}, "范围须为sheet_id!A1:B2形式，最多5000行、100列");
const cell = z.union([z.string().max(40000), z.number().finite(), z.boolean(), z.null()]);
const values = z.array(z.array(cell).min(1).max(100)).min(1).max(5000)
  .refine(v => v.every(row => row.length === v[0].length), "数据行宽度必须一致")
  .refine(v => Buffer.byteLength(JSON.stringify(v), "utf8") <= 8 * 1024 * 1024, "单次数据最多8MiB");
const sheetArgs = z.object({ spreadsheet_token: token }).strict();
const readOptions = {
  value_render_option: z.enum(["ToString", "Formula", "FormattedValue", "UnformattedValue"]).optional(),
  date_time_render_option: z.literal("FormattedString").optional(),
};
const readQuery = (a: { value_render_option?: string; date_time_render_option?: string }) => ({
  user_id_type: "open_id",
  ...(a.value_render_option !== undefined ? { valueRenderOption: a.value_render_option } : {}),
  ...(a.date_time_render_option !== undefined ? { dateTimeRenderOption: a.date_time_render_option } : {}),
});
const writeArgs = sheetArgs.extend({ range, values }).superRefine((a, ctx) => {
  const d = dimensions(a.range);
  if (d && (a.values.length > d.rows || a.values[0].length > d.columns)) ctx.addIssue({ code: "custom", message: "数据必须包含在指定范围内" });
});
const sheetPath = (a: { spreadsheet_token: string }, version: 2 | 3 = 3) => `/sheets/v${version}/spreadsheets/${a.spreadsheet_token}`;

export const feishuDriveSheetsOperations: Record<string, FeishuOperation> = {
  drive_files_list: { label: "读取云空间文件夹清单", domain: "云盘", build: args => {
    const a = z.object({ folder_token: token.optional(), page_size: z.number().int().min(1).max(200).default(100), page_token: z.string().min(1).max(4096).optional(), order_by: z.enum(["EditedTime", "CreatedTime"]).default("EditedTime"), direction: z.enum(["ASC", "DESC"]).default("DESC") }).strict().parse(args);
    if (!a.folder_token && a.page_token) throw new Error("根目录不支持分页，请指定folder_token");
    return { path: "/drive/v1/files", query: { ...a, user_id_type: "open_id" } };
  } },
  drive_files_metadata: { label: "读取云空间文件元数据", domain: "云盘", build: args => {
    const a = z.object({ request_docs: z.array(z.object({ doc_token: token, doc_type: docType }).strict()).min(1).max(200), with_url: z.boolean().default(false) }).strict().parse(args);
    return { method: "POST", path: "/drive/v1/metas/batch_query", query: { user_id_type: "open_id" }, body: a };
  } },
  drive_folder_create: { label: "新建云空间文件夹", domain: "云盘", write: true, build: args => {
    const a = z.object({ name, folder_token: z.union([token, z.literal("")]) }).strict().parse(args);
    return { method: "POST", path: "/drive/v1/files/create_folder", body: a };
  } },
  drive_file_copy: { label: "复制云空间文件", domain: "云盘", write: true, build: args => {
    const { file_token, ...body } = z.object({ file_token: token, folder_token: token, name, type: z.enum(["file", "doc", "sheet", "bitable", "docx", "mindnote", "slides"]) }).strict().parse(args);
    return { method: "POST", path: `/drive/v1/files/${file_token}/copy`, query: { user_id_type: "open_id" }, body };
  } },
  drive_export_create: { label: "创建云文档导出任务（不修改原文档）", domain: "云盘", build: args => {
    const a = z.object({ token: exportToken, type: z.enum(["doc", "docx", "sheet", "bitable"]), file_extension: z.enum(["docx", "pdf", "xlsx", "csv"]), sub_id: token.optional() }).strict().parse(args);
    const formats = a.type === "doc" || a.type === "docx" ? ["docx", "pdf"] : ["xlsx", "csv"];
    if (!formats.includes(a.file_extension) || (a.file_extension === "csv" && !a.sub_id) || (a.sub_id && a.file_extension !== "csv")) throw new Error("导出类型、格式和sub_id不匹配；CSV必须指定工作表或数据表ID");
    return { method: "POST", path: "/drive/v1/export_tasks", body: a };
  } },
  drive_export_get: { label: "查询云文档导出结果", domain: "云盘", build: args => {
    const a = z.object({ ticket: token, token: exportToken }).strict().parse(args);
    return { path: `/drive/v1/export_tasks/${a.ticket}`, query: { token: a.token } };
  } },
  drive_file_download: { label: "下载云空间文件", domain: "云盘", build: args => {
    const a = z.object({ file_token: token, filename: filename.optional() }).strict().parse(args);
    return { path: `/drive/v1/files/${a.file_token}/download`, download: { ...(a.filename !== undefined ? { filename: a.filename } : {}) } };
  } },
  drive_export_download: { label: "下载云文档导出产物", domain: "云盘", build: args => {
    const a = z.object({ file_token: token, filename: filename.optional() }).strict().parse(args);
    return { path: `/drive/v1/export_tasks/file/${a.file_token}/download`, download: { ...(a.filename !== undefined ? { filename: a.filename } : {}) } };
  } },
  spreadsheet_create: { label: "新建电子表格", domain: "电子表格", write: true, build: args => {
    const a = z.object({ title, folder_token: token.optional() }).strict().parse(args);
    return { method: "POST", path: "/sheets/v3/spreadsheets", body: a };
  } },
  spreadsheet_info: { label: "读取电子表格信息", domain: "电子表格", build: args => {
    const a = sheetArgs.parse(args);
    return { path: sheetPath(a), query: { user_id_type: "open_id" } };
  } },
  spreadsheet_sheets_list: { label: "读取电子表格工作表列表", domain: "电子表格", build: args => ({ path: `${sheetPath(sheetArgs.parse(args))}/sheets/query` }) },
  spreadsheet_sheet_create: { label: "新增电子表格工作表", domain: "电子表格", write: true, build: args => {
    const { spreadsheet_token, ...properties } = sheetArgs.extend({ title, index: z.number().int().min(0).max(299).optional() }).parse(args);
    return { method: "POST", path: `${sheetPath({ spreadsheet_token }, 2)}/sheets_batch_update`, body: { requests: [{ addSheet: { properties } }] } };
  } },
  spreadsheet_range_read: { label: "读取电子表格指定范围", domain: "电子表格", build: args => {
    const a = sheetArgs.extend({ range, ...readOptions }).parse(args);
    return { path: `${sheetPath(a, 2)}/values/${encodeURIComponent(a.range)}`, query: readQuery(a) };
  } },
  spreadsheet_ranges_read: { label: "读取电子表格多个指定范围", domain: "电子表格", build: args => {
    const a = sheetArgs.extend({ ranges: z.array(range).min(1).max(20), ...readOptions }).parse(args);
    return { path: `${sheetPath(a, 2)}/values_batch_get`, query: { ranges: a.ranges.join(","), ...readQuery(a) } };
  } },
  spreadsheet_range_update: { label: "覆盖电子表格指定范围数据", domain: "电子表格", write: true, build: args => {
    const a = writeArgs.parse(args);
    return { method: "PUT", path: `${sheetPath(a, 2)}/values`, body: { valueRange: { range: a.range, values: a.values } } };
  } },
  spreadsheet_range_append: { label: "在电子表格范围中追加数据", domain: "电子表格", write: true, build: args => {
    const { insert_data_option, ...input } = z.object({ spreadsheet_token: token, range, values, insert_data_option: z.enum(["OVERWRITE", "INSERT_ROWS"]).default("INSERT_ROWS") }).strict().parse(args);
    const a = writeArgs.parse(input);
    return { method: "POST", path: `${sheetPath(a, 2)}/values_append`, query: { insertDataOption: insert_data_option }, body: { valueRange: { range: a.range, values: a.values } } };
  } },
};
