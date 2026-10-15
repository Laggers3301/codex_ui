import { describe, expect, it } from "vitest";
import { feishuCalendarCommentOperations as ops, feishuCalendarCommentScopes } from "./feishuCalendarComments.js";

const event = { calendar_id: "feishu.cn_test@group.calendar.feishu.cn", event_id: "event_0" };
const file = { file_token: "docx_test", comment_id: "123456" };
const times = { start_time: { timestamp: "1791432000", timezone: "Asia/Shanghai" }, end_time: { timestamp: "1791435600", timezone: "Asia/Shanghai" } };
describe("personal calendar and document comments", () => {
  it("builds fixed official event routes and uses open_id", () => {
    expect(ops.calendar_event_get.build(event)).toEqual({ path: `/calendar/v4/calendars/${event.calendar_id}/events/event_0`, query: { user_id_type: "open_id" } });
    const created = ops.calendar_event_create.build({ calendar_id: event.calendar_id, idempotency_key: "550e8400-e29b-41d4-a716-446655440000", summary: "测试", ...times });
    expect(created.method).toBe("POST"); expect(created.body).toEqual({ summary: "测试", ...times });
    expect(ops.calendar_event_update.build({ ...event, summary: "新标题" })).toMatchObject({ method: "PATCH", body: { summary: "新标题" } });
  });
  it("validates time semantics, update fields and descriptions", () => {
    for (const a of [{ ...event }, { ...event, start_time: times.start_time }, { ...event, ...times, description: "a", description_rich: "b" }, { ...event, start_time: times.end_time, end_time: times.start_time }, { ...event, start_time: { date: "2026-02-30" }, end_time: { date: "2026-03-02" } }, { ...event, ...times, start_time: { ...times.start_time, date: "2026-10-08" } }]) expect(() => ops.calendar_event_update.build(a)).toThrow();
  });
  it("honors participant pagination and batch/room limits without admin options", () => {
    expect(ops.calendar_attendees_list.build(event).query?.page_size).toBe(20);
    expect(() => ops.calendar_attendees_list.build({ ...event, page_size: 9 })).toThrow();
    expect(() => ops.calendar_attendees_create.build({ ...event, attendees: Array.from({ length: 1001 }, () => ({ type: "user", user_id: "ou_test" })) })).toThrow();
    expect(() => ops.calendar_attendees_create.build({ ...event, attendees: Array.from({ length: 101 }, () => ({ type: "resource", room_id: "omm_test" })) })).toThrow();
    expect(ops.calendar_attendees_create.build({ ...event, attendees: [{ type: "user", user_id: "ou_test" }] })).toMatchObject({ method: "POST", query: { user_id_type: "open_id" } });
    expect(() => ops.calendar_attendees_create.build({ ...event, attendees: [{ type: "user", user_id: "ou_test" }], is_enable_admin: true })).toThrow();
  });
  it("queries at most 90 days and leaves the actor for verified server injection", () => {
    const a = { time_min: "2026-10-08T09:00:00+08:00", time_max: "2026-10-09T09:00:00+08:00" };
    expect(ops.calendar_freebusy.build(a)).toEqual({ method: "POST", path: "/calendar/v4/freebusy/list", query: { user_id_type: "open_id" }, body: a });
    for (const extra of [{ user_id: "ou_other" }, { room_id: "omm_other" }, { time_max: a.time_min }, { time_max: "2027-01-08T09:00:00+08:00" }]) expect(() => ops.calendar_freebusy.build({ ...a, ...extra })).toThrow();
  });
  it("builds new full-document comments, legacy replies and solve-only patches", () => {
    expect(ops.document_comments_create.build({ file_token: file.file_token, reply_elements: [{ type: "text", text: "核实完成" }] })).toEqual({ method: "POST", path: "/drive/v1/files/docx_test/new_comments", body: { file_type: "docx", reply_elements: [{ type: "text", text: "核实完成" }] } });
    expect(ops.document_comments_list.build({ file_token: file.file_token })).toMatchObject({ query: { file_type: "docx", page_size: 50 } });
    expect(ops.document_comment_replies_list.build(file).path).toBe("/drive/v1/files/docx_test/comments/123456/replies");
    expect(ops.document_comment_replies_create.build({ ...file, content: { elements: [{ type: "text_run", text_run: { text: "回复" } }] } })).toMatchObject({ method: "POST", body: { content: { elements: [{ type: "text_run", text_run: { text: "回复" } }] } } });
    expect(ops.document_comment_resolve.build(file)).toMatchObject({ method: "PATCH", body: { is_solved: true } });
    expect(() => ops.document_comment_resolve.build({ ...file, is_solved: false })).toThrow();
  });
  it("rejects path traversal, unrecognized transport fields, invalid element shapes and oversized pages", () => {
    for (const bad of ["../secret", "a/b", "a%2fb", "a?token=x", "a\\b"]) expect(() => ops.calendar_event_get.build({ ...event, event_id: bad })).toThrow();
    expect(() => ops.calendar_event_get.build({ ...event, access_token: "private" })).toThrow();
    expect(() => ops.document_comments_list.build({ file_token: "doc", page_size: 101 })).toThrow();
    expect(() => ops.document_comments_create.build({ file_token: "doc", reply_elements: [{ type: "text", text: "x", mention_user: "ou_test" }] })).toThrow();
    expect(() => ops.document_comments_create.build({ file_token: "doc", reply_elements: [{ type: "link", link: "javascript:alert(1)" }] })).toThrow();
  });
  it("marks every mutation for proposal confirmation and excludes deletes", () => {
    for (const name of ["calendar_event_create", "calendar_event_update", "calendar_attendees_create", "document_comments_create", "document_comment_replies_create", "document_comment_resolve"]) expect(ops[name].write).toBe(true);
    expect(Object.keys(ops).some(v => v.includes("delete"))).toBe(false);
    expect(feishuCalendarCommentScopes).toContain("docs:document.comment:create");
  });
});
