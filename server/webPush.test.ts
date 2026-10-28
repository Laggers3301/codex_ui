import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, expect, vi } from "vitest";
import webpush from "web-push";
vi.mock("web-push", () => ({ default: {
  generateVAPIDKeys: vi.fn(() => ({ publicKey: "fixture-public", privateKey: "fixture-private" })),
  setVapidDetails: vi.fn(), sendNotification: vi.fn().mockResolvedValue({ statusCode: 201 })
} }));

it("uses conversation title and preview by default, retaining explicit privacy opt-out per device", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "push-content-"));
  vi.stubEnv("CODEX_WEB_DATA_DIR", dir); vi.resetModules();
  try {
    const { sendUserPush } = await import("./webPush.js");
    const store = { listPushSubscriptions: () => [{ endpoint: "https://web.push.apple.com/fixture", keys: {} }, { endpoint: "https://fcm.googleapis.com/fixture", keys: {}, includePreview: false }],
      getThreadOwner: () => ({ displayName: "示例项目" }) };
    const result = await sendUserPush(store as any, "fixture", { type: "question", threadId: "thread", title: "Codex 等待你的回答", body: "点开会话作答", preview: "选择 **方案 A** 还是 B？" });
    expect(result).toEqual({ subscriptions: 2, accepted: 2, failed: 0 });
    const messages = vi.mocked(webpush.sendNotification).mock.calls.map(call => JSON.parse(String(call[1])));
    expect(messages[0]).toMatchObject({ title: "示例项目 · 等待回答", body: "选择 方案 A 还是 B？" });
    expect(messages[1]).toMatchObject({ title: "Codex 等待你的回答", body: "点开会话作答" });
    for (const message of messages) expect(message).not.toHaveProperty("preview");
  } finally { vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(dir, { recursive: true, force: true }); }
});
