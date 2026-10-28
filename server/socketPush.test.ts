import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexBridge } from "./codexBridge.js";
import { ProjectStore } from "./db.js";
import { attachSocketServer } from "./socket.js";
import { sendUserPush } from "./webPush.js";
vi.mock("./webPush.js", () => ({ sendUserPush: vi.fn().mockResolvedValue(undefined), pushPublicKey: vi.fn() }));

describe("question system push wiring", () => {
  it("sends native and async free-text prompts once, with owner isolation and no prompt text", async () => {
    vi.mocked(sendUserPush).mockClear();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "question-push-"));
    const store = new ProjectStore(path.join(dir, "store.sqlite"));
    const project = store.createProject({ name: "test", rootPath: dir });
    store.registerThreadOwner({ threadId: "thread-a", userId: "admin", projectId: project.id, rootPath: dir });
    const bridge = Object.assign(new EventEmitter(), { request: async () => ({}), getPendingServerRequests: () => [] });
    const server = http.createServer();
    const wss = attachSocketServer(server, bridge as unknown as CodexBridge, store);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      for (const method of ["item/started", "item/completed"]) bridge.emit("notification", { method, params: {
        threadId: "thread-a", turnId: "turn-a", item: { id: "async-q", type: "agentMessage", delivery: "async", questions: [{ question: "私密提问" }] }
      } });
      const request = { id: 123, method: "item/tool/requestUserInput", params: { threadId: "thread-a", turnId: "turn-a", itemId: "native-q", questions: [{ id: "q", question: "选什么？", options: [] }] } };
      bridge.emit("serverRequest", request); bridge.emit("serverRequest", request);
      bridge.emit("notification", { method: "item/completed", params: { threadId: "not-owned", turnId: "turn-a", item: { id: "other-q", type: "agentMessage", delivery: "async", questions: [{ question: "不能泄漏" }] } } });
      expect(sendUserPush).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(sendUserPush).mock.calls) {
        expect(call[1]).toBe("admin");
        expect(call[2]).toMatchObject({ type: "question", threadId: "thread-a", projectId: project.id });
        expect(call[2].body).not.toContain("私密提问");
      }
    } finally {
      await new Promise<void>(resolve => wss.close(() => server.close(() => resolve())));
      store.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
