import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeishuService, feishuOperations, defaultFeishuScopes, registerFeishuRoutes } from "./feishu.js";
import { createSessionCookie } from "./auth.js";

const directories: string[] = [];
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-test-")); directories.push(dir);
  vi.stubEnv("FEISHU_APP_ID", "cli_test"); vi.stubEnv("FEISHU_APP_SECRET", "fake-secret"); vi.stubEnv("FEISHU_REDIRECT_URI", "https://console.example/api/feishu/callback");
  const fetcher = vi.fn(async (url: any, options: any) => {
    if (String(url).endsWith("oauth/token")) return json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 7200, scope: "docx:document offline_access" });
    if (String(url).endsWith("user_info")) return json({ code: 0, data: { name: "测试用户" } });
    return json({ code: 0, data: { document: { document_id: "doc_test" } } });
  });
  const service = new FeishuService(dir, fetcher as any);
  const connect = async (user = "alice") => { const url = new URL(service.authorize(user).url); await service.callback(user, url.searchParams.get("state")!, "fake-code"); };
  return { dir, fetcher, service, connect };
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe("isolated Feishu office", () => {
  it("requests all implemented personal scopes for every new user by default without pre-granting permissions", () => {
    const { service } = setup();
    for (const user of ["alice", "bob"]) {
      const requested = new URL(service.authorize(user).url).searchParams.get("scope")!;
      expect(requested).toBe(defaultFeishuScopes);
      for (const scope of ["wiki:node:read", "docx:document", "im:chat:read", "approval:instance:write", "approval:task:write", "attendance:task:readonly", "report:task:readonly", "minutes:minutes.artifacts:read", "calendar:calendar.event:read"])
        expect(requested.split(" ")).toContain(scope);
      expect(service.status(user)).toMatchObject({ connected: false, needsAuthorization: true, scopes: "" });
    }
  });
  it("resolves wiki nodes through personal access without treating a wiki token as a docx id", async () => {
    const { service, connect, fetcher } = setup(); await connect(); fetcher.mockClear();
    fetcher.mockResolvedValueOnce(json({ code: 0, data: { node: { title: "PhysPosterior", obj_type: "docx", obj_token: "real-document" } } }));
    const r = await service.call("alice", "t", { action: "read", operation: "wiki_node", args: { token: "wiki-node" } }) as any;
    expect(r.data.node.obj_token).toBe("real-document");
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/open-apis/wiki/v2/spaces/get_node");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer private-access");
    expect(() => feishuOperations.wiki_node.build({ token: "../../private" })).toThrow();
  });
  it("binds attendance to the authenticated employee and keeps reports restricted to user token", async () => {
    const { service, connect, fetcher } = setup(); await connect(); fetcher.mockClear();
    fetcher.mockResolvedValueOnce(json({ code: 0, data: { user_id: "real-employee", open_id: "own-open-id" } }));
    await service.call("alice", "t", { action: "read", operation: "attendance_records", args: { check_date_from: 20261001, check_date_to: 20261008, user_ids: ["other-employee"] } });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).user_ids).toEqual(["real-employee"]);
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe("Bearer private-access");
    fetcher.mockClear();
    await service.call("alice", "t", { action: "read", operation: "reports_list", args: { commit_start_time: 1, commit_end_time: 2, user_id: "other-employee" } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty("user_id");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer private-access");
    expect(() => feishuOperations.attendance_records.build({ check_date_from: 20260230, check_date_to: 20261008 })).toThrow();
  });
  it("explains an inactive app bot without claiming that another personal authorization will fix it", async () => {
    const { service, connect, fetcher } = setup(); await connect();
    fetcher.mockResolvedValueOnce(json({ code: 232025, msg: "Bot ability is not activated." }));
    await expect(service.call("alice", "t", { action: "read", operation: "chats_list" })).rejects.toThrow("应用能力 → 机器人");
  });
  it("uses user-only approval routes, never forwards a supplied actor, and confirms writes once", async () => {
    const { service, connect, fetcher } = setup(); await connect(); fetcher.mockClear();
    await service.call("alice", "t", { action: "read", operation: "approvals_list", args: { user_id: "someone-else" } });
    expect(String(fetcher.mock.calls[0][0])).toContain("/approval/v4/tasks?");
    expect(String(fetcher.mock.calls[0][0])).not.toContain("someone-else");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer private-access");
    fetcher.mockClear();
    await expect(service.call("alice", "t", { action: "read", operation: "approval_approve", args: { instance_code: "instance", task_id: "task" } })).rejects.toThrow("写入必须");
    const p = await service.call("alice", "t", { action: "propose", operation: "approval_approve", args: { instance_code: "instance", task_id: "task", user_id: "someone-else", comment: "核实后同意" }, summary: "本人同意该审批" }) as any;
    expect(fetcher).not.toHaveBeenCalled();
    await expect(service.confirm("bob", p.proposalId, true)).rejects.toThrow("不存在");
    await service.confirm("alice", p.proposalId, true);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/open-apis/approval/v4/tasks/pass");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer private-access");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ instance_code: "instance", task_id: "task", comment: "核实后同意" });
    await expect(service.confirm("alice", p.proposalId, true)).rejects.toThrow("不能重复");
  });
  it("requires real structured forms and idempotency keys for personal leave initiation", () => {
    const built = feishuOperations.approval_initiate.build({ approval_code: "real-definition", form: [{ id: "leave-type", type: "input", value: "事假" }], request_id: "da12c707-cc5f-4d49-b2e0-22f1ac39d545", user_id: "other-person" });
    expect(built.path).toBe("/approval/v4/instances/initiate");
    expect(built.body).not.toHaveProperty("user_id");
    expect(JSON.parse((built.body as any).form)).toHaveLength(1);
    expect(() => feishuOperations.approval_initiate.build({ approval_code: "definition", form: "guessed-form", request_id: "bad" })).toThrow();
  });
  it("reports newly requested scopes separately from a still-valid older login", async () => {
    const { service, connect } = setup(); await connect();
    vi.stubEnv("FEISHU_SCOPES", "docx:document offline_access approval:task:read approval:task:write");
    expect(service.status("alice")).toMatchObject({ connected: true, needsAdditionalAuthorization: true, missingScopes: ["approval:task:read", "approval:task:write"] });
    expect(service.authorize("alice").url).toContain("approval%3Atask%3Awrite");
  });
  it("explains missing user grants without rotating tokens or falling back to an administrator", async () => {
    const { service, connect, fetcher } = setup(); await connect(); fetcher.mockClear();
    fetcher.mockResolvedValueOnce(json({ code: 99991679, msg: "Unauthorized" }));
    await expect(service.call("alice", "t", { action: "read", operation: "chats_list", args: {} })).rejects.toThrow("OAuth 申请范围并重新授权");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer private-access");
    expect(service.status("alice").connected).toBe(true);
  });
  it("uses each upstream API's pagination bounds", () => {
    expect(feishuOperations.chat_messages.build({ chat_id: "chat", page_size: 100 }).query?.page_size).toBe(50);
    expect(feishuOperations.calendar_list.build({ page_size: 1 }).query?.page_size).toBe(50);
    expect(feishuOperations.events_list.build({ calendar_id: "calendar", page_size: 10000 }).query?.page_size).toBe(1000);
  });
  it("reads minute transcripts from official artifacts without returning unrelated artifacts", async () => {
    const { service, connect, fetcher } = setup(); await connect();
    fetcher.mockImplementationOnce(async (url: any, options: any) => {
      expect(String(url)).toBe("https://open.feishu.cn/open-apis/minutes/v1/minutes/minute_test/artifacts");
      expect(options.headers.Authorization).toBe("Bearer private-access");
      return json({ code: 0, data: { transcript: "会议逐字稿", summary: "未要求的摘要" } });
    });
    expect(await service.call("alice", "t", { action: "read", operation: "meeting_transcript", args: { minute_token: "minute_test" } })).toEqual({ code: 0, data: { transcript: "会议逐字稿" } });
    fetcher.mockResolvedValueOnce(json({ code: 0, data: {} }));
    await expect(service.call("alice", "t", { action: "read", operation: "meeting_transcript", args: { minute_token: "minute_test" } })).rejects.toThrow("尚无可读取的逐字稿");
  });
  it("requires personal authorization even after application configuration and after application replacement", async () => {
    const { service, connect } = setup();
    expect(service.status("alice")).toMatchObject({ configured: true, connected: false, needsAuthorization: true, scopes: "" });
    expect(service.status("alice").capabilities).toEqual([]);
    expect(service.status("alice").requestedScopes).toContain("docx:document");
    await connect();
    expect(service.status("alice")).toMatchObject({ connected: true, needsAuthorization: false });
    expect(service.status("alice").capabilities).toEqual(["文档"]);
    expect(service.status("alice").pendingVerificationCapabilities).toEqual(["知识库", "云盘", "电子表格", "多维表格", "任务", "文档评论", "消息", "会议", "日历", "本人审批查询", "本人审批执行", "审批／请假申请", "本人考勤查询", "本人汇报查询"]);
    expect(service.status("alice").resourceAccessVerified).toBe(false);
    vi.stubEnv("FEISHU_APP_ID", "cli_replacement");
    expect(service.status("alice")).toMatchObject({ connected: false, needsAuthorization: true, scopes: "" });
    expect(service.status("alice").capabilities).toEqual([]);
    vi.stubEnv("FEISHU_APP_ID", "");
    expect(service.status("alice")).toMatchObject({ configured: false, connected: false, needsAuthorization: false });
  });
  it("binds OAuth state to its initiating user, uses PKCE and consumes the code once", async () => {
    const { service, fetcher } = setup(); const url = new URL(service.authorize("alice").url), state = url.searchParams.get("state")!;
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    await expect(service.callback("bob", state, "fake-code")).rejects.toThrow("不匹配"); expect(fetcher).not.toHaveBeenCalled();
    await service.callback("alice", state, "fake-code");
    expect(JSON.parse(fetcher.mock.calls[0][1].body).code_verifier).toBeTruthy();
    await expect(service.callback("alice", state, "fake-code")).rejects.toThrow("不匹配");
  });
  it("notifies same-origin tabs after an authenticated OAuth callback without exposing credentials", async () => {
    const { service } = setup(), app = Fastify(); registerFeishuRoutes(app, service);
    try {
      const url = new URL(service.authorize("alice").url), state = url.searchParams.get("state")!;
      const res = await app.inject({ url: `/api/feishu/callback?state=${state}&code=fake-code`, headers: { cookie: createSessionCookie("alice").split(";")[0] } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('BroadcastChannel("codex-feishu-auth")');
      expect(res.body).toContain('localStorage.setItem("codex:feishu-auth-updated"');
      expect(res.body).toContain('"userId":"alice"');
      for (const secret of ["private-access", "private-refresh", "fake-secret", "fake-code"]) expect(res.body).not.toContain(secret);
      expect(res.headers["content-security-policy"]).toContain("script-src 'nonce-");
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally { await app.close(); }
  });
  it("encrypts credentials and pending content, preserves after restart, and isolates users", async () => {
    const { dir, service, connect, fetcher } = setup(); await connect();
    expect(service.status("alice").connected).toBe(true); expect(service.status("bob").connected).toBe(false);
    const proposal = await service.call("alice", "thread-a", { action: "propose", operation: "document_create", args: { title: "私密日报正文" }, summary: "创建日报" }) as any;
    expect(proposal.requiresUserConfirmation).toBe(true);
    const bytes = fs.readdirSync(dir).filter(f => f.endsWith("json")).map(f => fs.readFileSync(path.join(dir, f), "utf8")).join("");
    expect(bytes).not.toContain("private-access"); expect(bytes).not.toContain("private-refresh"); expect(bytes).not.toContain("私密日报正文");
    expect(new FeishuService(dir, fetcher as any).status("alice").connected).toBe(true);
    await expect(service.confirm("bob", proposal.proposalId, true)).rejects.toThrow("不存在");
  });
  it("keeps writes in every new domain behind a user-owned confirmation and never a read call", async () => {
    const { service, connect, fetcher } = setup(); await connect(); fetcher.mockClear();
    const cases = [
      ["drive_folder_create", { name: "日报", folder_token: "" }],
      ["spreadsheet_range_update", { spreadsheet_token: "sheet", range: "tab!A1:A1", values: [["已完成"]] }],
      ["bitable_record_create", { app_token: "base", table_id: "table", fields: { 标题: "周报" } }],
      ["bitable_app_create", { name: "新工作台" }],
      ["bitable_table_create", { app_token: "base", table: { name: "任务" } }],
      ["bitable_field_create", { app_token: "base", table_id: "table", field_name: "状态", type: 3, property: { options: [{ name: "todo" }] } }],
      ["bitable_field_update", { app_token: "base", table_id: "table", field_id: "fld1", field_name: "标题", type: 1 }],
      ["bitable_view_create", { app_token: "base", table_id: "table", view_name: "排期", view_type: "gantt" }],
      ["bitable_view_update", { app_token: "base", table_id: "table", view_id: "vew1", view_name: "总览" }],
      ["task_create", { summary: "准备周报" }],
      ["calendar_event_create", { calendar_id: "cal", idempotency_key: "3a2c0df6-56c0-42a6-ab2d-ae1aee343d0b", start_time: { date: "2026-10-08" }, end_time: { date: "2026-10-09" } }],
      ["document_comments_create", { file_token: "doc", reply_elements: [{ type: "text", text: "请核实这里的数值" }] }],
    ] as const;
    for (const [operation, args] of cases) {
      await expect(service.call("alice", "t", { action: "read", operation, args })).rejects.toThrow("写入必须");
      const staged = await service.call("alice", "t", { action: "propose", operation, args, summary: "预览后确认改动" }) as any;
      expect(staged.requiresUserConfirmation).toBe(true);
      await expect(service.confirm("bob", staged.proposalId, true)).rejects.toThrow("不存在");
    }
    expect(fetcher).not.toHaveBeenCalled();
    const proposal = service.proposals("alice")[0];
    await service.confirm("alice", proposal.id, true);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer private-access");
    expect(String(fetcher.mock.calls[0][0])).toContain("/drive/v1/files/create_folder");
    await expect(service.confirm("alice", proposal.id, true)).rejects.toThrow("不能重复");
  });
  it("binds busy-time reads to the verified OAuth user instead of a client actor", async () => {
    const { service, connect, fetcher } = setup();
    fetcher.mockImplementation(async (url: any) => String(url).endsWith("oauth/token") ? json({ access_token: "private-access", expires_in: 7200, scope: "calendar:calendar.free_busy:read" }) : String(url).endsWith("user_info") ? json({ code: 0, data: { name: "本人", open_id: "ou_verified" } }) : json({ code: 0, data: {} }));
    await connect(); fetcher.mockClear();
    await service.call("alice", "t", { action: "read", operation: "calendar_freebusy", args: { time_min: "2026-10-08T00:00:00+08:00", time_max: "2026-10-09T00:00:00+08:00" } });
    expect(JSON.parse(fetcher.mock.calls[0][1].body).user_id).toBe("ou_verified");
    await expect(service.call("alice", "t", { action: "read", operation: "calendar_freebusy", args: { time_min: "2026-10-08T00:00:00+08:00", time_max: "2026-10-09T00:00:00+08:00", user_id: "ou_other" } })).rejects.toThrow();
  });
  it("serves bounded binary and JSON downloads only to their logged-in owner without exposing access tokens", async () => {
    const { service, connect, fetcher } = setup(); await connect();
    fetcher.mockResolvedValueOnce(new Response("sample-pdf", { headers: { "content-type": "application/pdf" } }));
    const result = await service.call("alice", "t", { action: "read", operation: "drive_file_download", args: { file_token: "file", filename: "报告.pdf" } }) as any;
    expect(result.data.bytes).toBe(10); expect(JSON.stringify(result)).not.toContain("private-access");
    const app = Fastify(); registerFeishuRoutes(app, service);
    try {
      const url = result.data.download_url;
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { cookie: createSessionCookie("bob").split(";")[0] } })).statusCode).toBe(404);
      const own = await app.inject({ url, headers: { cookie: createSessionCookie("alice").split(";")[0] } });
      expect(own.statusCode).toBe(200); expect(own.body).toBe("sample-pdf"); expect(own.headers["content-disposition"]).toContain("attachment;");
      expect(own.headers["cache-control"]).toBe("private, no-store");
      fetcher.mockResolvedValueOnce(new Response('{"actual":"file content"}', { headers: { "content-type": "application/json" } }));
      expect((await service.call("alice", "t", { action: "read", operation: "drive_file_download", args: { file_token: "file2", filename: "data.json" } }) as any).data.download_url).toContain("/api/feishu/downloads/");
      vi.useFakeTimers(); vi.setSystemTime(Date.now() + 24 * 3600000 + 1);
      expect(() => service.download("alice", result.data.download_id)).toThrow("过期");
    } finally { await app.close(); }
  });
  it("rejects oversized upstream downloads and unknown or administrative operations", async () => {
    const { service, connect, fetcher } = setup(); await connect(); fetcher.mockClear();
    fetcher.mockResolvedValueOnce(new Response("small-body", { headers: { "content-type": "application/pdf", "content-length": String(26 * 1024 * 1024) } }));
    await expect(service.call("alice", "t", { action: "read", operation: "drive_file_download", args: { file_token: "large" } })).rejects.toThrow("25MB");
    for (const operation of ["file_delete", "permission_public_update", "admin_impersonate"]) await expect(service.call("alice", "t", { action: "read", operation })).rejects.toThrow("未知操作");
    expect(service.status("alice").operationCount).toBe(75);
    expect(defaultFeishuScopes.split(" ").length).toBe(new Set(defaultFeishuScopes.split(" ")).size);
  });
  it("stages writes without executing and permits exactly one authenticated confirmation", async () => {
    const { service, connect, fetcher } = setup(); await connect(); fetcher.mockClear();
    await expect(service.call("alice", "t", { action: "read", operation: "document_create", args: { title: "日报" } })).rejects.toThrow("写入必须");
    const p = await service.call("alice", "t", { action: "propose", operation: "document_create", args: { title: "日报" }, summary: "在本人云盘新建日报" }) as any;
    expect(fetcher).not.toHaveBeenCalled();
    await service.confirm("alice", p.proposalId, true); expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(service.confirm("alice", p.proposalId, true)).rejects.toThrow("不能重复");
    expect((await service.call("alice", "t", { action: "results" }) as any).proposals[0].status).toBe("done");
    expect((await service.call("alice", "another-thread", { action: "results" }) as any).proposals).toEqual([]);
  });
  it("single-flights token rotation and never retries an ambiguous refresh", async () => {
    const { service, connect, fetcher } = setup(); await connect(); vi.useFakeTimers(); vi.setSystemTime(Date.now() + 7200000); fetcher.mockClear();
    await Promise.all([1,2,3].map(() => service.call("alice", "t", { action: "read", operation: "document_read", args: { document_id: "doc" } })));
    expect(fetcher.mock.calls.filter(c => String(c[0]).endsWith("oauth/token"))).toHaveLength(1);
    vi.setSystemTime(Date.now() + 7200000); fetcher.mockRejectedValueOnce(new Error("network contains-secret"));
    await expect(service.call("alice", "t", { action: "read", operation: "document_read", args: { document_id: "doc" } })).rejects.toThrow("未自动重试");
    const count = fetcher.mock.calls.length;
    await expect(service.call("alice", "t", { action: "read", operation: "document_read", args: { document_id: "doc" } })).rejects.toThrow("重新授权");
    expect(fetcher.mock.calls.length).toBe(count);
  });
  it("uses a new OAuth login immediately and prevents an old in-flight refresh overwriting it", async () => {
    const { service, connect, fetcher } = setup(); await connect();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 7200000);
    let release!: (response: Response) => void;
    fetcher.mockImplementation(async (url: any, options: any) => {
      if (String(url).endsWith("oauth/token")) {
        const body = JSON.parse(options.body);
        if (body.grant_type === "refresh_token") return new Promise<Response>(resolve => { release = resolve; });
        return json({ access_token: "new-login-access", refresh_token: "new-login-refresh", expires_in: 7200, scope: "docx:document offline_access" });
      }
      expect(options.headers.Authorization).toBe("Bearer new-login-access");
      if (String(url).endsWith("user_info")) return json({ code: 0, data: { name: "新的本人授权", open_id: "own-id" } });
      return json({ code: 0, data: {} });
    });
    const oldRead = service.call("alice", "t", { action: "read", operation: "document_info", args: { document_id: "doc" } });
    const rejected = expect(oldRead).rejects.toThrow("撤销或替换");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await connect();
    expect(service.status("alice")).toMatchObject({ connected: true, identity: "新的本人授权" });
    await service.call("alice", "t", { action: "read", operation: "document_info", args: { document_id: "doc" } });
    release(json({ access_token: "old-rotated-access", refresh_token: "old-rotated-refresh", expires_in: 7200 }));
    await rejected;
    expect(service.status("alice")).toMatchObject({ connected: true, identity: "新的本人授权" });
    await service.call("alice", "t", { action: "read", operation: "document_info", args: { document_id: "doc" } });
  });
  it("refuses path traversal, arbitrary routes and model self-approval", async () => {
    const { service, connect, fetcher } = setup(); await connect(); fetcher.mockClear();
    for (const operation of ["http://evil.test", "admin_impersonate"]) await expect(service.call("alice", "t", { action: "read", operation })).rejects.toThrow("未知操作");
    await expect(service.call("alice", "t", { action: "read", operation: "document_read", args: { document_id: "../private" } })).rejects.toThrow();
    await expect(service.call("alice", "t", { action: "confirm" })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not silently retry a write whose upstream result is unknown", async () => {
    const { service, connect, fetcher } = setup(); await connect();
    const p = await service.call("alice", "t", { action: "propose", operation: "document_create", args: { title: "日报" }, summary: "新建日报" }) as any;
    fetcher.mockRejectedValueOnce(new Error("network lost"));
    await expect(service.confirm("alice", p.proposalId, true)).rejects.toThrow("结果可能未知");
    expect(service.proposals("alice")[0].status).toBe("uncertain");
    await expect(service.confirm("alice", p.proposalId, true)).rejects.toThrow("不能重复");
  });
  it("separates definite rejection from uncertain writes and dismisses only owner-local hints", async () => {
    const { service, connect, fetcher } = setup(); await connect();
    const p = await service.call("alice", "t", { action: "propose", operation: "document_create", args: { title: "草稿" }, summary: "测试拒绝" }) as any;
    await expect(Promise.resolve().then(() => service.dismiss("alice", p.proposalId))).rejects.toThrow("只能关闭");
    fetcher.mockResolvedValueOnce(json({ code: 1254019, msg: "InvalidViewType" }, 400));
    await expect(service.confirm("alice", p.proposalId, true)).rejects.toThrow("不是个人授权未完成");
    expect(service.proposals("alice")[0].status).toBe("failed");
    expect(() => service.dismiss("bob", p.proposalId)).toThrow("不存在");
    fetcher.mockClear();
    expect(service.dismiss("alice", p.proposalId)).toEqual({ dismissed: true });
    expect(service.proposals("alice")[0].status).toBe("dismissed");
    expect(service.status("alice").connected).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("marks an interrupted write uncertain after restart without resubmitting", async () => {
    const { dir, service, connect, fetcher } = setup(); await connect();
    const p = await service.call("alice", "t", { action: "propose", operation: "document_create", args: { title: "日报" }, summary: "新建日报" }) as any;
    let release!: (response: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const running = service.confirm("alice", p.proposalId, true);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(service.proposals("alice")[0].status).toBe("executing");
    const restarted = new FeishuService(dir, fetcher as any);
    expect(restarted.proposals("alice")[0].status).toBe("uncertain");
    await expect(restarted.confirm("alice", p.proposalId, true)).rejects.toThrow("不能重复");
    release(json({ code: 0, data: {} })); await running;
  });
  it("disconnect clears pending authorizations and local pending actions only", async () => {
    const { service, connect } = setup(); await connect(); const state = new URL(service.authorize("alice").url).searchParams.get("state")!;
    service.disconnect("alice"); expect(service.status("alice").connected).toBe(false);
    await expect(service.callback("alice", state, "fake-code")).rejects.toThrow("不匹配");
  });
  it("protects routes by real session cookies rather than a claimed user header", async () => {
    const { service } = setup(), app = Fastify(); registerFeishuRoutes(app, service);
    try {
      expect((await app.inject({ url: "/api/feishu/status", headers: { "x-codex-web-user-id": "alice" } })).statusCode).toBe(401);
      const headers = { cookie: createSessionCookie("alice").split(";")[0] };
      expect((await app.inject({ url: "/api/feishu/status", headers })).json().configured).toBe(true);
      expect((await app.inject({ method: "POST", url: "/api/feishu/authorize", headers })).json().url).toContain("code_challenge");
      expect((await app.inject({ method: "POST", url: "/api/feishu/proposals/not-a-uuid/confirm", headers, payload: { approved: true } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it("allows bot history only after verifying the OAuth user's group membership", async () => {
    const { service, connect, fetcher } = setup(); await connect(); vi.stubEnv("FEISHU_BOT_MESSAGING", "true"); fetcher.mockClear();
    fetcher.mockImplementation(async (url: any, options: any) => {
      if (String(url).includes("/im/v1/chats")) { expect(options.headers.Authorization).toBe("Bearer private-access"); return json({ code: 0, data: { items: [{ chat_id: "own-chat" }], has_more: false } }); }
      if (String(url).endsWith("tenant_access_token/internal")) return json({ code: 0, tenant_access_token: "private-bot-token", expire: 7200 });
      expect(options.headers.Authorization).toBe("Bearer private-bot-token"); return json({ code: 0, data: { items: [] } });
    });
    await expect(service.call("alice", "t", { action: "read", operation: "chat_messages", args: { chat_id: "other-chat" } })).rejects.toThrow("不在本人");
    expect(fetcher.mock.calls).toHaveLength(1);
    await service.call("alice", "t", { action: "read", operation: "chat_messages", args: { chat_id: "own-chat" } });
    expect(fetcher.mock.calls.filter(c => String(c[0]).endsWith("tenant_access_token/internal"))).toHaveLength(1);
    expect(JSON.stringify(service.status("alice"))).not.toContain("private-bot-token");
    await expect(service.call("alice", "t", { action: "propose", operation: "message_send", args: { receive_id_type: "open_id", receive_id: "other-user", text: "hi", request_id: "unique" }, summary: "给其他用户发送" })).rejects.toThrow();
  });
  it("loads a single administrator configuration without exposing its secret", () => {
    const { dir, service } = setup(); vi.unstubAllEnvs();
    fs.writeFileSync(path.join(dir, "application.json"), JSON.stringify({ appId: "cli_local", appSecret: "never-display", redirectUri: "https://console.example/api/feishu/callback" }), { mode: 0o600 });
    expect(service.status("alice").configured).toBe(true);
    expect(JSON.stringify(service.status("alice"))).not.toContain("never-display");
    fs.chmodSync(path.join(dir, "application.json"), 0o644);
    expect(service.status("alice").configured).toBe(false);
  });
});
