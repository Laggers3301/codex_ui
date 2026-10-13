import { describe, expect, it } from "vitest";
import { feishuDriveSheetsOperations as operations } from "./feishuDriveSheets.js";

const sheet = "sheetToken123";
const selection = "sheet01!A1:B2";
const cells = [["名称", 1], [null, true]];
const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ["drive_files_list", { folder_token: "folder123", page_size: 200, page_token: "next+/=" }, { path: "/drive/v1/files", query: { folder_token: "folder123", page_size: 200, page_token: "next+/=", order_by: "EditedTime", direction: "DESC", user_id_type: "open_id" } }],
  ["drive_files_metadata", { request_docs: [{ doc_token: "doc123", doc_type: "docx" }] }, { method: "POST", path: "/drive/v1/metas/batch_query", query: { user_id_type: "open_id" }, body: { request_docs: [{ doc_token: "doc123", doc_type: "docx" }], with_url: false } }],
  ["drive_folder_create", { name: "项目", folder_token: "" }, { method: "POST", path: "/drive/v1/files/create_folder", body: { name: "项目", folder_token: "" } }],
  ["drive_file_copy", { file_token: "doc123", folder_token: "folder123", name: "副本", type: "docx" }, { method: "POST", path: "/drive/v1/files/doc123/copy", query: { user_id_type: "open_id" }, body: { folder_token: "folder123", name: "副本", type: "docx" } }],
  ["drive_export_create", { token: sheet, type: "sheet", file_extension: "csv", sub_id: "sheet01" }, { method: "POST", path: "/drive/v1/export_tasks", body: { token: sheet, type: "sheet", file_extension: "csv", sub_id: "sheet01" } }],
  ["drive_export_get", { token: sheet, ticket: "ticket123" }, { path: "/drive/v1/export_tasks/ticket123", query: { token: sheet } }],
  ["drive_file_download", { file_token: "file123", filename: "报告.pdf" }, { path: "/drive/v1/files/file123/download", download: { filename: "报告.pdf" } }],
  ["drive_export_download", { file_token: "file123" }, { path: "/drive/v1/export_tasks/file/file123/download", download: {} }],
  ["spreadsheet_create", { title: "预算", folder_token: "folder123" }, { method: "POST", path: "/sheets/v3/spreadsheets", body: { title: "预算", folder_token: "folder123" } }],
  ["spreadsheet_info", { spreadsheet_token: sheet }, { path: `/sheets/v3/spreadsheets/${sheet}`, query: { user_id_type: "open_id" } }],
  ["spreadsheet_sheets_list", { spreadsheet_token: sheet }, { path: `/sheets/v3/spreadsheets/${sheet}/sheets/query` }],
  ["spreadsheet_sheet_create", { spreadsheet_token: sheet, title: "明细", index: 1 }, { method: "POST", path: `/sheets/v2/spreadsheets/${sheet}/sheets_batch_update`, body: { requests: [{ addSheet: { properties: { title: "明细", index: 1 } } }] } }],
  ["spreadsheet_range_read", { spreadsheet_token: sheet, range: selection, value_render_option: "FormattedValue", date_time_render_option: "FormattedString" }, { path: `/sheets/v2/spreadsheets/${sheet}/values/sheet01!A1%3AB2`, query: { user_id_type: "open_id", valueRenderOption: "FormattedValue", dateTimeRenderOption: "FormattedString" } }],
  ["spreadsheet_ranges_read", { spreadsheet_token: sheet, ranges: [selection, "sheet02!C1:D5"] }, { path: `/sheets/v2/spreadsheets/${sheet}/values_batch_get`, query: { ranges: "sheet01!A1:B2,sheet02!C1:D5", user_id_type: "open_id" } }],
  ["spreadsheet_range_update", { spreadsheet_token: sheet, range: selection, values: cells }, { method: "PUT", path: `/sheets/v2/spreadsheets/${sheet}/values`, body: { valueRange: { range: selection, values: cells } } }],
  ["spreadsheet_range_append", { spreadsheet_token: sheet, range: selection, values: cells }, { method: "POST", path: `/sheets/v2/spreadsheets/${sheet}/values_append`, query: { insertDataOption: "INSERT_ROWS" }, body: { valueRange: { range: selection, values: cells } } }],
];

describe("飞书云空间与电子表格固定官方操作", () => {
  it.each(cases)("%s生成实际官方请求形状", (key, args, request) => {
    expect(operations[key].build(args)).toEqual(request);
  });
  it.each(cases)("%s拒绝未知字段与任意URL", (key, args) => {
    expect(() => operations[key].build({ ...args, url: "https://evil.example" })).toThrow();
  });
  it("仅真实修改操作标记write，导出不修改源文件", () => {
    const writes = Object.entries(operations).filter(([, op]) => op.write).map(([key]) => key);
    expect(writes).toEqual(["drive_folder_create", "drive_file_copy", "spreadsheet_create", "spreadsheet_sheet_create", "spreadsheet_range_update", "spreadsheet_range_append"]);
  });
  it.each(["../doc", "a/b", "%2f", "..", "https://evil.example", "abc?x=y", "a\\b", "a\n"])("拒绝非法标识符%s", bad => {
    for (const [key, args] of cases) {
      const idKeys = Object.keys(args).filter(k => k !== "page_token" && /token$|ticket$|sub_id$/.test(k));
      for (const field of idKeys) expect(() => operations[key].build({ ...args, [field]: bad })).toThrow();
    }
    expect(() => operations.drive_files_metadata.build({ request_docs: [{ doc_token: bad, doc_type: "docx" }] })).toThrow();
  });
  it.each(["sheet01", "sheet01!A:B", "sheet01!A1:B", "sheet01!B2:A1", "sheet01!A0:B2", "sheet01!A1:CZ2", "sheet01!A1:B5001", "../sheet!A1:B2", "sheet01!A1:B2?x=1"])("拒绝无界或非法范围%s", bad => {
    expect(() => operations.spreadsheet_range_read.build({ spreadsheet_token: sheet, range: bad })).toThrow();
  });
  it("严格校验分页、元数据数量、UTF-8名称及导出组合", () => {
    for (const page_size of [0, 201, 1.5, "100"]) expect(() => operations.drive_files_list.build({ page_size })).toThrow();
    expect(() => operations.drive_files_list.build({ page_token: "next" })).toThrow();
    expect(() => operations.drive_files_metadata.build({ request_docs: Array.from({ length: 201 }, () => ({ doc_token: "d", doc_type: "docx" })) })).toThrow();
    expect(() => operations.drive_folder_create.build({ name: "中".repeat(86), folder_token: "" })).toThrow();
    for (const args of [{ token: sheet, type: "sheet", file_extension: "pdf" }, { token: sheet, type: "sheet", file_extension: "csv" }, { token: sheet, type: "docx", file_extension: "pdf", sub_id: "s" }]) expect(() => operations.drive_export_create.build(args)).toThrow();
  });
  it("拒绝超范围、参差行、未知对象单元格与超长字符串", () => {
    for (const values of [[[1, 2, 3]], [[1], [1, 2]], [[{ url: "https://evil.example" }]], [[Infinity]], [["a".repeat(40001)]]]) expect(() => operations.spreadsheet_range_update.build({ spreadsheet_token: sheet, range: selection, values })).toThrow();
    expect(() => operations.spreadsheet_sheet_create.build({ spreadsheet_token: sheet, title: "x", requests: [{ deleteSheet: { sheetId: "x" } }] })).toThrow();
    expect(() => operations.spreadsheet_range_append.build({ spreadsheet_token: sheet, range: selection, values: cells, insert_data_option: "DROP" })).toThrow();
  });
  it.each(["../x.pdf", "a/b.pdf", "a\\b.pdf", "\r\nevil", ".."])("拒绝不安全的下载文件名%s", bad => {
    expect(() => operations.drive_file_download.build({ file_token: "file123", filename: bad })).toThrow();
  });
});
