import { z } from "zod";
import type { FeishuOperation } from "./feishuOperationTypes.js";

// Schemas follow larksuite/node-sdk code-gen/projects/{bitable,task}.ts.
// All requests use the service's user_access_token; no member/share/admin APIs.
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const text = z.string().max(10000);
const pageShape = (maximum: number) => ({ page_size: z.number().int().min(1).max(maximum).default(50), page_token: z.string().min(1).max(4096).optional() });
const appShape = { app_token: id };
const tableShape = { ...appShape, table_id: id };
const pagination = (a: { page_size: number; page_token?: string }) => ({ page_size: a.page_size, ...(a.page_token ? { page_token: a.page_token } : {}) });
const tablePath = (a: { app_token: string; table_id: string }) => `/bitable/v1/apps/${a.app_token}/tables/${a.table_id}`;
const link = z.object({ text: text.optional(), link: z.string().url().max(2048) }).strict();
const member = z.object({ id }).strict();
const attachment = z.object({ file_token: id }).strict();
const location = z.object({ location: z.string().max(100), pname: text.optional(), cityname: text.optional(), adname: text.optional(), address: text.optional(), name: text.optional(), full_address: text.optional() }).strict();
// Typed field values only. No opaque JSON payload or caller-controlled credentials.
const cell = z.union([text, z.number().finite(), z.boolean(), link, location, z.array(text).max(500), z.array(member).max(100), z.array(attachment).max(100)]);
const fields = z.record(z.string().min(1).max(200), cell).refine(a => Object.keys(a).length >= 1 && Object.keys(a).length <= 200, "字段数量必须为 1–200");
const condition = z.object({ field_name: z.string().min(1).max(200), operator: z.enum(["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty", "isGreater", "isGreaterEqual", "isLess", "isLessEqual", "like", "in"]), value: z.array(text).max(100).optional() }).strict();
const filterGroup = z.object({ conjunction: z.enum(["and", "or"]), conditions: z.array(condition).max(100).optional() }).strict();
const searchSchema = z.object({ ...tableShape, ...pageShape(500), view_id: id.optional(), field_names: z.array(z.string().min(1).max(200)).max(200).optional(), sort: z.array(z.object({ field_name: z.string().min(1).max(200), desc: z.boolean().optional() }).strict()).max(100).optional(), filter: filterGroup.extend({ children: z.array(filterGroup).max(20).optional() }).optional(), automatic_fields: z.boolean().optional() }).strict();
const millis = z.string().regex(/^(0|[1-9]\d{0,15})$/);
const taskTime = z.object({ timestamp: millis, is_all_day: z.boolean().optional() }).strict();
const taskShape = { summary: z.string().min(1).max(3000).optional(), description: z.string().max(3000).optional(), start: taskTime.optional(), due: taskTime.optional(), completed_at: millis.optional() };
const taskValues = z.object(taskShape).strict().refine(a => !a.start || !a.due || BigInt(a.start.timestamp) <= BigInt(a.due.timestamp), "开始时间不能晚于截止时间");
const userQuery = { user_id_type: "open_id" };
const assignees = z.array(z.string().regex(/^ou_[A-Za-z0-9]+$/)).min(1).max(50).refine(a => new Set(a).size === a.length, "负责人不能重复");
const asMembers = (ids: string[]) => ids.map(id => ({ id, type: "user", role: "assignee" }));
const schemaName = z.string().trim().min(1).max(100);
const fieldDefinition = z.object({
  field_name: schemaName,
  type: z.number().int().refine(n => [1, 2, 3, 4, 5, 7, 11, 13, 15, 17, 18, 21].includes(n), "当前支持文本、数字、选择、日期、复选、人员、电话、链接、附件及关联字段"),
  property: z.object({
    options: z.array(z.object({ name: schemaName, id: id.optional(), color: z.number().int().min(0).max(54).optional() }).strict()).max(500).optional(),
    formatter: z.string().max(100).optional(), date_formatter: z.string().max(100).optional(),
    auto_fill: z.boolean().optional(), multiple: z.boolean().optional(),
    table_id: id.optional(), back_field_name: schemaName.optional(),
  }).strict().optional(),
  description: z.object({ text: z.string().max(2000), disable_sync: z.boolean().optional() }).strict().optional(),
}).strict();
const viewProperty = z.object({
  hidden_fields: z.array(id).max(200).optional(),
  filter_info: z.object({ conjunction: z.enum(["and", "or"]), conditions: z.array(z.object({ field_id: id, operator: z.enum(["is", "isNot", "contains", "doesNotContain", "isEmpty", "isNotEmpty", "isGreater", "isGreaterEqual", "isLess", "isLessEqual"]), value: z.string().max(10000).optional() }).strict()).max(100) }).strict().optional(),
}).strict();

export const feishuBitableTasksOperations: Record<string, FeishuOperation> = {
  bitable_app_create: { label: "新建多维表格 Base", domain: "多维表格", write: true, build: args => ({ method: "POST", path: "/bitable/v1/apps", body: z.object({ name: schemaName, folder_token: id.optional(), time_zone: z.string().max(100).optional() }).strict().parse(args) }) },
  bitable_table_create: { label: "新建数据表及字段", domain: "多维表格", write: true, build: args => { const a = z.object({ ...appShape, table: z.object({ name: schemaName, default_view_name: schemaName.optional(), fields: z.array(fieldDefinition).min(1).max(200).optional() }).strict() }).strict().parse(args); return { method: "POST", path: `/bitable/v1/apps/${a.app_token}/tables`, body: { table: a.table } }; } },
  bitable_table_update: { label: "修改数据表名称", domain: "多维表格", write: true, build: args => { const a = z.object({ ...tableShape, name: schemaName }).strict().parse(args); return { method: "PATCH", path: tablePath(a), body: { name: a.name } }; } },
  bitable_field_create: { label: "新增字段与选择项", domain: "多维表格", write: true, build: args => { const { app_token, table_id, ...body } = fieldDefinition.extend(tableShape).strict().parse(args); return { method: "POST", path: `${tablePath({ app_token, table_id })}/fields`, body }; } },
  bitable_field_update: { label: "修改字段定义（可能影响现有数据）", domain: "多维表格", write: true, build: args => { const { app_token, table_id, field_id, ...body } = fieldDefinition.extend({ ...tableShape, field_id: id }).strict().parse(args); return { method: "PUT", path: `${tablePath({ app_token, table_id })}/fields/${field_id}`, body }; } },
  bitable_views_list: { label: "列出数据表视图", domain: "多维表格", build: args => { const a = z.object({ ...tableShape, ...pageShape(100) }).strict().parse(args); return { path: `${tablePath(a)}/views`, query: pagination(a) }; } },
  bitable_view_get: { label: "读取视图配置", domain: "多维表格", build: args => { const a = z.object({ ...tableShape, view_id: id }).strict().parse(args); return { path: `${tablePath(a)}/views/${a.view_id}` }; } },
  bitable_view_create: { label: "新建表格／看板／甘特视图", domain: "多维表格", write: true, build: args => { const { app_token, table_id, ...body } = z.object({ ...tableShape, view_name: schemaName, view_type: z.enum(["grid", "kanban", "gallery", "gantt", "form"]).default("grid") }).strict().parse(args); return { method: "POST", path: `${tablePath({ app_token, table_id })}/views`, body }; } },
  bitable_view_update: { label: "修改视图名称、筛选及隐藏字段", domain: "多维表格", write: true, build: args => { const { app_token, table_id, view_id, ...body } = z.object({ ...tableShape, view_id: id, view_name: schemaName.optional(), property: viewProperty.optional() }).strict().refine(a => a.view_name !== undefined || (a.property && Object.keys(a.property).length > 0), "须指定至少一个视图修改字段").parse(args); return { method: "PATCH", path: `${tablePath({ app_token, table_id })}/views/${view_id}`, query: userQuery, body }; } },
  bitable_app_info: { label: "读取多维表格信息", domain: "多维表格", build: args => { const a = z.object(appShape).strict().parse(args); return { path: `/bitable/v1/apps/${a.app_token}` }; } },
  bitable_tables_list: { label: "列出多维表格数据表", domain: "多维表格", build: args => { const a = z.object({ ...appShape, ...pageShape(100) }).strict().parse(args); return { path: `/bitable/v1/apps/${a.app_token}/tables`, query: pagination(a) }; } },
  bitable_fields_list: { label: "列出数据表字段", domain: "多维表格", build: args => { const a = z.object({ ...tableShape, ...pageShape(100), view_id: id.optional() }).strict().parse(args); return { path: `${tablePath(a)}/fields`, query: { ...pagination(a), ...(a.view_id ? { view_id: a.view_id } : {}) } }; } },
  bitable_records_search: { label: "搜索多维表格记录", domain: "多维表格", build: args => { const a = searchSchema.parse(args); const { app_token: _app, table_id: _table, page_size: _size, page_token: _page, ...body } = a; return { method: "POST", path: `${tablePath(a)}/records/search`, query: { ...pagination(a), ...userQuery }, body }; } },
  bitable_record_create: { label: "新增多维表格记录", domain: "多维表格", write: true, build: args => { const a = z.object({ ...tableShape, fields }).strict().parse(args); return { method: "POST", path: `${tablePath(a)}/records`, query: userQuery, body: { fields: a.fields } }; } },
  bitable_record_update: { label: "修改多维表格记录", domain: "多维表格", write: true, build: args => { const a = z.object({ ...tableShape, record_id: id, fields }).strict().parse(args); return { method: "PUT", path: `${tablePath(a)}/records/${a.record_id}`, query: userQuery, body: { fields: a.fields } }; } },
  bitable_records_batch_create: { label: "批量新增多维表格记录（最多1000条）", domain: "多维表格", write: true, build: args => { const a = z.object({ ...tableShape, records: z.array(z.object({ fields }).strict()).min(1).max(1000) }).strict().parse(args); return { method: "POST", path: `${tablePath(a)}/records/batch_create`, query: userQuery, body: { records: a.records } }; } },
  bitable_records_batch_update: { label: "批量修改多维表格记录（最多1000条）", domain: "多维表格", write: true, build: args => { const a = z.object({ ...tableShape, records: z.array(z.object({ record_id: id, fields }).strict()).min(1).max(1000) }).strict().parse(args); return { method: "POST", path: `${tablePath(a)}/records/batch_update`, query: userQuery, body: { records: a.records } }; } },
  tasks_list: { label: "列出本人负责的任务", domain: "任务", build: args => { const a = z.object({ ...pageShape(100), completed: z.boolean().optional() }).strict().parse(args); return { path: "/task/v2/tasks", query: { ...pagination(a), ...userQuery, type: "my_tasks", ...(a.completed !== undefined ? { completed: a.completed } : {}) } }; } },
  task_get: { label: "读取本人可访问任务", domain: "任务", build: args => { const a = z.object({ task_guid: id }).strict().parse(args); return { path: `/task/v2/tasks/${a.task_guid}`, query: userQuery }; } },
  task_create: { label: "以本人身份创建任务", domain: "任务", write: true, build: args => { const a = z.object({ ...taskShape, summary: z.string().min(1).max(3000), client_token: z.string().min(1).max(100).optional(), assignee_open_ids: assignees.optional() }).strict().parse(args); const { client_token, assignee_open_ids, ...task } = a; taskValues.parse(task); return { method: "POST", path: "/task/v2/tasks", query: userQuery, body: { ...task, ...(client_token ? { client_token } : {}), ...(assignee_open_ids ? { members: asMembers(assignee_open_ids) } : {}) } }; } },
  task_add_assignees: { label: "添加任务负责人（不移除现有负责人）", domain: "任务", write: true, build: args => { const a = z.object({ task_guid: id, assignee_open_ids: assignees, client_token: z.string().min(1).max(100).optional() }).strict().parse(args); return { method: "POST", path: `/task/v2/tasks/${a.task_guid}/add_members`, query: userQuery, body: { members: asMembers(a.assignee_open_ids), ...(a.client_token ? { client_token: a.client_token } : {}) } }; } },
  task_update: { label: "修改任务／标记完成或恢复", domain: "任务", write: true, build: args => { const a = z.object({ task_guid: id, task: taskValues }).strict().parse(args); const update_fields = Object.keys(a.task); if (!update_fields.length) throw new Error("必须提供至少一个任务修改字段"); return { method: "PATCH", path: `/task/v2/tasks/${a.task_guid}`, query: userQuery, body: { task: a.task, update_fields } }; } },
  tasklists_list: { label: "列出本人可访问任务清单", domain: "任务", build: args => { const a = z.object(pageShape(100)).strict().parse(args); return { path: "/task/v2/tasklists", query: { ...pagination(a), ...userQuery } }; } },
  tasklist_create: { label: "创建本人任务清单（不添加协作者）", domain: "任务", write: true, build: args => { const a = z.object({ name: z.string().min(1).max(100) }).strict().parse(args); return { method: "POST", path: "/task/v2/tasklists", query: userQuery, body: a }; } },
  task_comments_list: { label: "读取任务评论", domain: "任务", build: args => { const a = z.object({ task_guid: id, ...pageShape(100), direction: z.enum(["asc", "desc"]).default("asc") }).strict().parse(args); return { path: "/task/v2/comments", query: { ...pagination(a), ...userQuery, resource_type: "task", resource_id: a.task_guid, direction: a.direction } }; } },
  task_comment_create: { label: "以本人身份添加任务评论", domain: "任务", write: true, build: args => { const a = z.object({ task_guid: id, content: z.string().min(1).max(3000), reply_to_comment_id: id.optional() }).strict().parse(args); return { method: "POST", path: "/task/v2/comments", query: userQuery, body: { resource_type: "task", resource_id: a.task_guid, content: a.content, ...(a.reply_to_comment_id ? { reply_to_comment_id: a.reply_to_comment_id } : {}) } }; } },
};
