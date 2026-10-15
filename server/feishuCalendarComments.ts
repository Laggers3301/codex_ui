import { z } from "zod";
import type { FeishuOperation } from "./feishuOperationTypes.js";

// Official sources: larksuite/node-sdk code-gen/projects/{calendar,drive}.ts,
// open.feishu.cn/api/tools/open/api_definition?protocol=meta&client_version=1.0.24.
// All listed endpoints support user_access_token. Resource ACLs still apply.
export const feishuCalendarCommentScopes = ["calendar:calendar.event:read", "calendar:calendar.event:create", "calendar:calendar.event:update", "calendar:calendar.free_busy:read", "docs:document.comment:read", "docs:document.comment:create", "docs:document.comment:update"];
const id = z.string().regex(/^[A-Za-z0-9_@.:-]{1,200}$/).refine(v => !v.includes(".."), "ID 不允许路径穿越");
const openId = z.string().regex(/^ou_[A-Za-z0-9]+$/);
const pagination = { page_size: z.number().int().min(1).max(100).default(50), page_token: z.string().min(1).max(4096).optional() };
const eventIds = { calendar_id: id, event_id: id };
const fileIds = { file_token: id, file_type: z.enum(["doc", "docx"]).default("docx") };
const rfcTime = z.string().datetime({ offset: true });
const validDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v; });
const time = z.object({ date: validDate.optional(), timestamp: z.string().regex(/^\d{1,12}$/).optional(), timezone: z.string().min(1).max(100).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }).optional() }).strict().refine(v => (v.date !== undefined) !== (v.timestamp !== undefined), "date 与 timestamp 必须二选一");
const eventFields = {
  summary: z.string().min(1).max(1000).optional(), description: z.string().max(10000).optional(), description_rich: z.string().max(10000).optional(),
  start_time: time.optional(), end_time: time.optional(), need_notification: z.boolean().optional(),
  visibility: z.enum(["default", "public", "private"]).optional(), free_busy_status: z.enum(["busy", "free"]).optional(),
  attendee_ability: z.enum(["none", "can_see_others", "can_invite_others", "can_modify_event"]).optional(),
  location: z.object({ name: z.string().max(1000).optional(), address: z.string().max(1000).optional(), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() }).strict().optional(),
};
function checkEvent(v: { start_time?: z.infer<typeof time>; end_time?: z.infer<typeof time>; description?: string; description_rich?: string }, required: boolean) {
  if (v.description !== undefined && v.description_rich !== undefined) throw new Error("纯文本与富文本描述不能同时传入。");
  if (required && (!v.start_time || !v.end_time)) throw new Error("创建日程必须提供起止时间。");
  if (!!v.start_time !== !!v.end_time) throw new Error("修改日程起止时间必须同时提供。");
  if (v.start_time && v.end_time) {
    if (!!v.start_time.date !== !!v.end_time.date) throw new Error("起止时间必须使用相同类型。");
    const start = v.start_time.date ? Date.parse(v.start_time.date) : Number(v.start_time.timestamp) * 1000;
    const end = v.end_time.date ? Date.parse(v.end_time.date) : Number(v.end_time.timestamp) * 1000;
    if (end <= start) throw new Error("结束时间必须晚于开始时间。");
  }
}
const attendee = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), user_id: openId, is_optional: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("chat"), chat_id: id, is_optional: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("third_party"), third_party_email: z.string().email().max(320), is_optional: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("resource"), room_id: id, approval_reason: z.string().min(1).max(1000).optional() }).strict(),
]);
const url = z.string().url().max(2000).refine(v => ["http:", "https:"].includes(new URL(v).protocol));
const replyElement = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_run"), text_run: z.object({ text: z.string().min(1).max(1000) }).strict() }).strict(),
  z.object({ type: z.literal("person"), person: z.object({ user_id: openId }).strict() }).strict(),
  z.object({ type: z.literal("docs_link"), docs_link: z.object({ url }).strict() }).strict(),
]);
const newElement = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1).max(1000) }).strict(),
  z.object({ type: z.literal("mention_user"), mention_user: openId }).strict(),
  z.object({ type: z.literal("link"), link: url }).strict(),
]);
const eventPath = (v: { calendar_id: string; event_id?: string }) => `/calendar/v4/calendars/${v.calendar_id}/events${v.event_id ? `/${v.event_id}` : ""}`;
const commentPath = (v: { file_token: string; comment_id?: string }) => `/drive/v1/files/${v.file_token}/comments${v.comment_id ? `/${v.comment_id}` : ""}`;

export const feishuCalendarCommentOperations: Record<string, FeishuOperation> = {
  calendar_event_get: { label: "读取本人可访问的日程详情", domain: "日历", build: a => { const { calendar_id, event_id, ...query } = z.object({ ...eventIds, need_attendee: z.boolean().optional(), max_attendee_num: z.number().int().min(0).max(100).optional() }).strict().parse(a); return { path: eventPath({ calendar_id, event_id }), query: { ...query, user_id_type: "open_id" } }; } },
  calendar_event_create: { label: "以本人身份创建日程", domain: "日历", write: true, build: a => { const { calendar_id, idempotency_key, ...body } = z.object({ calendar_id: id, idempotency_key: z.string().uuid(), ...eventFields }).strict().parse(a); checkEvent(body, true); return { method: "POST", path: eventPath({ calendar_id }), query: { user_id_type: "open_id", idempotency_key }, body }; } },
  calendar_event_update: { label: "以本人身份修改可编辑日程", domain: "日历", write: true, build: a => { const { calendar_id, event_id, ...body } = z.object({ ...eventIds, ...eventFields }).strict().parse(a); if (!Object.keys(body).length) throw new Error("至少提供一个修改字段。"); checkEvent(body, false); return { method: "PATCH", path: eventPath({ calendar_id, event_id }), query: { user_id_type: "open_id" }, body }; } },
  calendar_attendees_list: { label: "读取本人可访问日程的参与人", domain: "日历", build: a => { const { calendar_id, event_id, ...query } = z.object({ ...eventIds, ...pagination, page_size: z.number().int().min(10).max(100).default(20) }).strict().parse(a); return { path: `${eventPath({ calendar_id, event_id })}/attendees`, query: { ...query, user_id_type: "open_id" } }; } },
  calendar_attendees_create: { label: "以本人日程权限添加参与人", domain: "日历", write: true, build: a => { const { calendar_id, event_id, ...body } = z.object({ ...eventIds, attendees: z.array(attendee).min(1).max(1000).refine(v => v.filter(x => x.type === "resource").length <= 100, "单次最多100个会议室"), need_notification: z.boolean().optional() }).strict().parse(a); return { method: "POST", path: `${eventPath({ calendar_id, event_id })}/attendees`, query: { user_id_type: "open_id" }, body }; } },
  // FeishuService must inject verified authenticated-user open_id; no client actor or room is accepted.
  calendar_freebusy: { label: "查询本人主日历忙闲", domain: "日历", build: a => { const body = z.object({ time_min: rfcTime, time_max: rfcTime, include_external_calendar: z.boolean().optional(), only_busy: z.boolean().optional(), need_rsvp_status: z.boolean().optional() }).strict().parse(a); const span = Date.parse(body.time_max) - Date.parse(body.time_min); if (span <= 0 || span > 90 * 86400000) throw new Error("忙闲查询时间范围须大于0且不超过90天。"); return { method: "POST", path: "/calendar/v4/freebusy/list", query: { user_id_type: "open_id" }, body }; } },
  document_comments_list: { label: "读取本人可访问文档评论", domain: "文档评论", build: a => { const { file_token, ...query } = z.object({ ...fileIds, ...pagination, is_whole: z.boolean().optional(), is_solved: z.boolean().optional() }).strict().parse(a); return { path: commentPath({ file_token }), query: { ...query, user_id_type: "open_id" } }; } },
  document_comments_create: { label: "以本人身份添加文档全文评论", domain: "文档评论", write: true, build: a => { const { file_token, ...body } = z.object({ ...fileIds, reply_elements: z.array(newElement).min(1).max(100) }).strict().parse(a); return { method: "POST", path: `/drive/v1/files/${file_token}/new_comments`, body }; } },
  document_comment_replies_list: { label: "读取本人可访问文档评论回复", domain: "文档评论", build: a => { const { file_token, comment_id, ...query } = z.object({ ...fileIds, comment_id: id, ...pagination }).strict().parse(a); return { path: `${commentPath({ file_token, comment_id })}/replies`, query: { ...query, user_id_type: "open_id" } }; } },
  document_comment_replies_create: { label: "以本人身份回复文档评论", domain: "文档评论", write: true, build: a => { const { file_token, comment_id, file_type, content } = z.object({ ...fileIds, comment_id: id, content: z.object({ elements: z.array(replyElement).min(1).max(100) }).strict() }).strict().parse(a); return { method: "POST", path: `${commentPath({ file_token, comment_id })}/replies`, query: { file_type, user_id_type: "open_id" }, body: { content } }; } },
  document_comment_resolve: { label: "将本人可操作文档评论标记为已解决", domain: "文档评论", write: true, build: a => { const { file_token, comment_id, file_type } = z.object({ ...fileIds, comment_id: id }).strict().parse(a); return { method: "PATCH", path: commentPath({ file_token, comment_id }), query: { file_type }, body: { is_solved: true } }; } },
};
