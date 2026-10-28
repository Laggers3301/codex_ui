import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProjectStore } from "./db.js";
import type { CommunicationOperation } from "../shared/sessionCommunication.js";

async function fixture(run: (test: any) => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-bus-")), file = path.join(root, "store.sqlite");
  let now = Date.parse("2026-10-28T10:00:00Z"), store: ProjectStore;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  store = new ProjectStore(file); store.ensureUser("other", "other");
  const project = store.createProject({ name: "bus test", rootPath: root });
  for (const threadId of ["a", "b", "c"]) { store.registerThreadOwner({ threadId, userId: "admin", projectId: project.id, rootPath: root }); store.updateThreadDisplayName(threadId, "admin", "会话 " + threadId); }
  const foreign = store.createProject({ name: "private", rootPath: root, userId: "other" });
  store.registerThreadOwner({ threadId: "foreign", userId: "other", projectId: foreign.id, rootPath: root });
  let sequence = 0;
  const send = (threadId: string, operation: CommunicationOperation, requestId = `test-request-${++sequence}`) => store.communication.execute("admin", threadId, { ...operation, requestId });
  try { await run({ get store() { return store; }, project, send, file, advance: (ms: number) => { now += ms; }, reopen: () => { store.close(); store = new ProjectStore(file); } }); }
  finally { store.close(); clock.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
}
describe("ROS-style per-session communication", () => {
  it("delivers a topic to its subscribers, retains unread messages, and does not replay earlier publications to late subscribers", () => fixture(({ store, send }: any) => {
    send("b", { operation: "topic.subscribe", name: "status" });
    const published = send("a", { operation: "topic.publish", name: "/status", message: "状态 1" });
    expect(published.delivered).toBe(1); expect(store.communication.snapshot("admin", "b").inbox[0]).toMatchObject({ id: published.id, message: "状态 1", unread: true });
    send("c", { operation: "topic.subscribe", name: "/status" }); expect(store.communication.snapshot("admin", "c").inbox).toEqual([]);
    send("b", { operation: "inbox.ack", id: published.id }); expect(store.communication.snapshot("admin", "b").unreadCount).toBe(0);
    send("b", { operation: "topic.unsubscribe", name: "/status" });
    expect(send("a", { operation: "topic.publish", name: "/status", message: "状态 2" }).delivered).toBe(1);
    expect(store.communication.snapshot("admin", "b").inbox).toHaveLength(1); expect(store.communication.snapshot("admin", "c").inbox).toHaveLength(1);
  }));
  it("deduplicates a lost reply across backend restart and rejects reuse of a request id with different content", () => fixture(test => {
    test.send("b", { operation: "topic.subscribe", name: "/status" });
    const operation = { operation: "topic.publish", name: "/status", message: "只投递一次" } as const;
    const first = test.send("a", operation, "stable-request-id"); test.reopen();
    expect(test.send("a", operation, "stable-request-id")).toEqual(first);
    expect(test.store.communication.snapshot("admin", "b").inbox).toHaveLength(1);
    expect(() => test.send("a", { ...operation, message: "其他内容" }, "stable-request-id")).toThrow("其他内容");
  }));
  it("correlates concurrent Service calls and permits only the original provider to return a result", () => fixture(({ store, send }: any) => {
    send("b", { operation: "service.advertise", name: "/sum" });
    expect(() => send("c", { operation: "service.advertise", name: "/sum" })).toThrow("已有提供会话");
    const one = send("a", { operation: "service.call", name: "/sum", message: "1+1" }), two = send("a", { operation: "service.call", name: "/sum", message: "2+2" });
    expect(() => send("c", { operation: "service.respond", id: one.id, result: "错误提供者", success: true })).toThrow("提供会话");
    send("b", { operation: "service.respond", id: two.id, result: "4", success: true });
    expect(store.communication.get("admin", "a", two.id).result).toBe("4"); expect(store.communication.get("admin", "a", one.id).state).toBe("pending");
    send("b", { operation: "service.respond", id: one.id, result: "2", success: true }); expect(store.communication.get("admin", "a", one.id).result).toBe("2");
    expect(() => send("b", { operation: "service.respond", id: one.id, result: "再回复", success: true })).toThrow("已经结束");
  }));
  it("times out unanswered Services, refuses late replies, and preserves accepted Actions past their acceptance deadline", () => fixture(({ store, send, advance }: any) => {
    send("b", { operation: "service.advertise", name: "/sum" }); send("b", { operation: "action.advertise", name: "/work" });
    const service = send("a", { operation: "service.call", name: "/sum", message: "1+1", timeoutSeconds: 1 });
    const queued = send("a", { operation: "action.send", name: "/work", message: "未接收", timeoutSeconds: 1 });
    const active = send("a", { operation: "action.send", name: "/work", message: "长任务", timeoutSeconds: 1 }); send("b", { operation: "action.update", id: active.id, status: "accepted" });
    advance(2000);
    expect(store.communication.get("admin", "a", service.id).state).toBe("timed_out");
    expect(store.communication.get("admin", "a", queued.id).state).toBe("timed_out"); expect(store.communication.get("admin", "a", active.id).state).toBe("accepted");
    expect(() => send("b", { operation: "service.respond", id: service.id, result: "迟到", success: true })).toThrow("已经结束");
  }));
  it("requires acceptance, tracks feedback, and leaves a running cancellation unconfirmed until its provider acknowledges", () => fixture(({ store, send }: any) => {
    send("b", { operation: "action.advertise", name: "/work" });
    const goal = send("a", { operation: "action.send", name: "/work", message: "处理文件" });
    expect(() => send("b", { operation: "action.update", id: goal.id, status: "executing", progress: 20 })).toThrow("先接收");
    send("b", { operation: "action.update", id: goal.id, status: "accepted" }); send("b", { operation: "action.update", id: goal.id, status: "executing", message: "已完成一半", progress: 50 });
    expect(store.communication.get("admin", "a", goal.id)).toMatchObject({ state: "executing", progress: 50 });
    expect(() => send("c", { operation: "action.cancel", id: goal.id })).toThrow("发起会话");
    send("a", { operation: "action.cancel", id: goal.id }); expect(store.communication.get("admin", "a", goal.id).state).toBe("cancel_requested");
    send("b", { operation: "action.update", id: goal.id, status: "executing", message: "正在收尾" }); expect(store.communication.get("admin", "a", goal.id).state).toBe("cancel_requested");
    send("b", { operation: "action.update", id: goal.id, status: "canceled", message: "已核对并停止本任务" }); expect(store.communication.get("admin", "a", goal.id).state).toBe("canceled");
    expect(() => send("b", { operation: "action.update", id: goal.id, status: "succeeded", message: "迟到结果" })).toThrow("已经结束");
  }));
  it("can reject or cancel an unaccepted goal and bounds feedback history", () => fixture(({ store, send }: any) => {
    send("b", { operation: "action.advertise", name: "/work" });
    const rejected = send("a", { operation: "action.send", name: "/work", message: "不能接收" }); send("b", { operation: "action.update", id: rejected.id, status: "rejected", message: "当前无能力执行" });
    expect(store.communication.get("admin", "a", rejected.id).state).toBe("rejected");
    const canceled = send("a", { operation: "action.send", name: "/work", message: "尚未执行" }); send("a", { operation: "action.cancel", id: canceled.id });
    expect(store.communication.get("admin", "a", canceled.id).state).toBe("canceled"); expect(() => send("b", { operation: "action.update", id: canceled.id, status: "accepted" })).toThrow();
    const goal = send("a", { operation: "action.send", name: "/work", message: "进度" }); send("b", { operation: "action.update", id: goal.id, status: "accepted" });
    for (let index = 0; index < 55; index++) send("b", { operation: "action.update", id: goal.id, status: "executing", progress: index, message: String(index) });
    expect(store.communication.get("admin", "a", goal.id).feedback).toHaveLength(50);
    send("b", { operation: "action.update", id: goal.id, status: "succeeded", message: "已完成" }); expect(store.communication.get("admin", "a", goal.id).progress).toBe(100);
  }));
  it("enforces user, subscriber, provider and source boundaries", () => fixture(({ store, send }: any) => {
    send("b", { operation: "topic.subscribe", name: "/status" }); const publication = send("a", { operation: "topic.publish", name: "/status", message: "私有数据" });
    expect(() => store.communication.snapshot("other", "b")).toThrow(); expect(() => store.communication.get("other", "foreign", publication.id)).toThrow();
    expect(() => store.communication.get("admin", "c", publication.id)).toThrow(); expect(() => send("c", { operation: "inbox.ack", id: publication.id })).toThrow();
    expect(store.communication.snapshot("other", "foreign").directory).toEqual([]);
    expect(() => send("a", { operation: "topic.publish", name: "/status", message: "", userId: "other" })).toThrow();
    expect(() => send("a", { operation: "topic.publish", name: "/status", message: "x".repeat(16001) })).toThrow();
  }));
  it("removes archived providers from discovery and applies bounded backpressure without hiding unfinished requests", () => fixture(({ store, project, send }: any) => {
    send("b", { operation: "service.advertise", name: "/sum" });
    for (let index = 0; index < 25; index++) send("a", { operation: "service.call", name: "/sum", message: String(index) });
    expect(() => send("a", { operation: "service.call", name: "/sum", message: "overflow" })).toThrow("25");
    expect(store.communication.snapshot("admin", "b").inbox).toHaveLength(25);
    store.setThreadLocallyArchived("b", "admin", project.id, true);
    expect(store.communication.snapshot("admin", "a").directory).toEqual([]); expect(() => send("c", { operation: "service.call", name: "/sum", message: "offline" })).toThrow("没有可用");
    expect(() => store.communication.snapshot("admin", "b")).toThrow();
  }));
});
