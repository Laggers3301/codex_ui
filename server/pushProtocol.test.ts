import { describe, expect, it } from "vitest";
import { pushSubscriptionSchema, questionNotificationIdentity, validatePushEndpoint, pushPreviewText } from "./pushProtocol.js";

const subscription = { endpoint: "https://fcm.googleapis.com/example", keys: { p256dh: "x".repeat(65), auth: "x".repeat(22) } };
describe("browser push protocol", () => {
  it("makes bounded plain-text previews without dumping code or link URLs", () => {
    expect(pushPreviewText("## 完成 **修改**\n[报告](https://example.test/private)\n```js\nsecret\n```" )).toBe("完成 修改 报告 [代码]");
    expect(Array.from(pushPreviewText("甲".repeat(200)))).toHaveLength(141);
    expect(pushPreviewText("🙂".repeat(200))).not.toContain("�");
  });
  it("supports Microsoft Edge WNS endpoints without permitting arbitrary callback URLs", () => {
    for (const host of ["fcm.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com", "wns2-am3p.notify.windows.com"]) {
      expect(() => validatePushEndpoint(`https://${host}/example`)).not.toThrow();
    }
    for (const endpoint of ["http://wns2-am3p.notify.windows.com/x", "https://notify.windows.com.evil.test/x", "https://127.0.0.1/x", "https://evil.test/x", "https://user@wns2-am3p.notify.windows.com/x", "https://wns2-am3p.notify.windows.com:999/x"]) {
      expect(() => validatePushEndpoint(endpoint)).toThrow();
    }
  });
  it("accepts browser-standard expirationTime and stores only transport fields", () => {
    for (const expirationTime of [null, undefined, 1794000000000]) {
      expect(pushSubscriptionSchema.parse({ ...subscription, expirationTime })).toEqual(subscription);
    }
  });
  it("still rejects unknown keys and malformed credentials", () => {
    expect(pushSubscriptionSchema.safeParse({ ...subscription, malicious: true }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...subscription, expirationTime: "never" }).success).toBe(false);
    expect(pushSubscriptionSchema.safeParse({ ...subscription, keys: { auth: "a", p256dh: "b" } }).success).toBe(false);
  });
  it("recognizes free-text async questions as well as explicit tool questions", () => {
    for (const item of [
      { id: "question", type: "agentMessage", delivery: "async", questions: [{ question: "如何处理？" }] },
      { id: "question", type: "toolCall", tool: "request_user_input_async", input: JSON.stringify({ questions: [{ question: "选哪个？", options: ["A", "B"] }] }) }
    ]) {
      expect(questionNotificationIdentity({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item } })).toEqual({ threadId: "thread", itemId: "question" });
    }
  });
  it("never infers pending questions from ordinary prose or incomplete arguments", () => {
    for (const item of [
      { id: "q", type: "agentMessage", text: "你选哪个？" },
      { id: "q", tool: "request_user_input_async", input: '{"questions":' },
      { id: "q", tool: "request_user_input_async", input: '{"accepted":true}' }
    ]) expect(questionNotificationIdentity({ method: "item/started", params: { threadId: "t", turnId: "r", item } })).toBeNull();
  });
});
