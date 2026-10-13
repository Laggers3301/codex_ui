import { describe, expect, it } from "vitest";
import { feishuBitableTasksOperations as ops } from "./feishuBitableTasks.js";
const table = { app_token: "app_test", table_id: "tbl_test" };
describe("飞书多维表格与本人任务请求构建", () => {
  it("新建表结构及视图采用原生接口，全部写操作须确认", () => {
    const field = { field_name: "状态", type: 3, property: { options: [{ name: "todo" }, { name: "in progress" }] } };
    expect(ops.bitable_table_create.build({ app_token: table.app_token, table: { name: "任务", fields: [field] } })).toEqual({ method: "POST", path: "/bitable/v1/apps/app_test/tables", body: { table: { name: "任务", fields: [field] } } });
    expect(ops.bitable_field_create.build({ ...table, ...field }).body).toEqual(field);
    expect(ops.bitable_field_update.build({ ...table, field_id: "fld1", ...field }).path).toBe("/bitable/v1/apps/app_test/tables/tbl_test/fields/fld1");
    expect(ops.bitable_view_create.build({ ...table, view_name: "排期", view_type: "gantt" }).body).toEqual({ view_name: "排期", view_type: "gantt" });
    expect(ops.bitable_view_update.build({ ...table, view_id: "vew1", property: { hidden_fields: ["fld1"] } }).method).toBe("PATCH");
    expect(ops.bitable_app_create.build({ name: "项目" }).path).toBe("/bitable/v1/apps");
    expect(ops.bitable_views_list.build(table).query).toEqual({ page_size: 50 });
    expect(() => ops.bitable_field_create.build({ ...table, ...field, property: { token: "secret" } })).toThrow();
    expect(() => ops.bitable_view_update.build({ ...table, view_id: "vew1" })).toThrow();
    expect(() => ops.bitable_view_create.build({ ...table, view_name: "日历", view_type: "calendar" })).toThrow();
  });
  it("固定多维表格路由、字段及搜索结构", () => {
    expect(ops.bitable_app_info.build({ app_token: "app_test" })).toEqual({ path: "/bitable/v1/apps/app_test" });
    expect(ops.bitable_record_update.build({ ...table, record_id: "rec1", fields: { 标题: "待办", 完成: true } })).toEqual({ method: "PUT", path: "/bitable/v1/apps/app_test/tables/tbl_test/records/rec1", query: { user_id_type: "open_id" }, body: { fields: { 标题: "待办", 完成: true } } });
    expect(ops.bitable_records_search.build({ ...table, page_size: 500, filter: { conjunction: "and", conditions: [{ field_name: "标题", operator: "contains", value: ["待办"] }] } })).toMatchObject({ method: "POST", query: { page_size: 500 }, body: { filter: { conjunction: "and" } } });
  });
  it("分页遵守界限且不会静默截断", () => {
    expect(ops.tasks_list.build({ page_token: "cursor=", completed: false }).query).toEqual({ page_size: 50, page_token: "cursor=", user_id_type: "open_id", type: "my_tasks", completed: false });
    for (const name of ["tasks_list", "tasklists_list", "task_comments_list", "bitable_tables_list", "bitable_fields_list"]) {
      const args = name.startsWith("bitable") ? table : name === "task_comments_list" ? { task_guid: "task1" } : {};
      expect(() => ops[name].build({ ...args, page_size: 101 })).toThrow();
      expect(() => ops[name].build({ ...args, page_size: 0 })).toThrow();
    }
    expect(() => ops.bitable_records_search.build({ ...table, page_size: 501 })).toThrow();
    expect(() => ops.tasks_list.build({ page_size: 1.5 })).toThrow();
  });
  it("批量最多1000且每条严格校验", () => {
    const records = Array.from({ length: 1000 }, () => ({ fields: { 标题: "a" } }));
    expect(ops.bitable_records_batch_create.build({ ...table, records }).body).toEqual({ records });
    expect(() => ops.bitable_records_batch_create.build({ ...table, records: [...records, records[0]] })).toThrow();
    expect(() => ops.bitable_records_batch_update.build({ ...table, records: [{ fields: { 标题: "a" } }] })).toThrow();
    expect(() => ops.bitable_record_create.build({ ...table, fields: { 人员: [{ id: "ou_test", access_token: "evil" }] } })).toThrow();
  });
  it("完成／恢复任务只更新显式字段，任务不添加清单协作权限", () => {
    for (const completed_at of ["1780000000000", "0"]) expect(ops.task_update.build({ task_guid: "task1", task: { completed_at } })).toEqual({ method: "PATCH", path: "/task/v2/tasks/task1", query: { user_id_type: "open_id" }, body: { task: { completed_at }, update_fields: ["completed_at"] } });
    expect(() => ops.task_update.build({ task_guid: "task1", task: {} })).toThrow();
    expect(() => ops.task_update.build({ task_guid: "task1", task: { due: { timestamp: "100" }, start: { timestamp: "101" } } })).toThrow();
    expect(ops.task_create.build({ summary: "任务", assignee_open_ids: ["ou_person"] }).body).toEqual({ summary: "任务", members: [{ id: "ou_person", type: "user", role: "assignee" }] });
    expect(ops.task_add_assignees.build({ task_guid: "task1", assignee_open_ids: ["ou_person"] }).path).toBe("/task/v2/tasks/task1/add_members");
    expect(() => ops.tasklist_create.build({ name: "清单", members: [] })).toThrow();
  });
  it("任务评论固定资源类型且写操作必须确认", () => {
    expect(ops.task_comment_create.build({ task_guid: "task1", content: "已跟进", reply_to_comment_id: "comment1" }).body).toEqual({ resource_type: "task", resource_id: "task1", content: "已跟进", reply_to_comment_id: "comment1" });
    for (const [name, op] of Object.entries(ops)) if (/create|update|assignees/.test(name)) expect(op.write).toBe(true);
  });
  it("拒绝路径穿越、凭据和身份覆盖、任意嵌套请求", () => {
    for (const value of ["../app", "%2Fapp", "a/b", "a?x", "a\\b", "https://evil"]) expect(() => ops.bitable_app_info.build({ app_token: value })).toThrow();
    for (const key of ["user_id", "access_token", "token", "url", "method"]) expect(() => ops.tasks_list.build({ [key]: "evil" })).toThrow();
    expect(() => ops.task_update.build({ task_guid: "t", task: { members: [{ id: "other" }] } })).toThrow();
    expect(() => ops.bitable_records_search.build({ ...table, filter: { conjunction: "and", secret: "evil" } })).toThrow();
    expect(() => ops.task_add_assignees.build({ task_guid: "t", assignee_open_ids: ["user_other"] })).toThrow();
  });
});
