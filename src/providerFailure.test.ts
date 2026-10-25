import { describe, expect, it } from "vitest";
import { classifyProviderFailure, providerFailureCopy } from "./providerFailure";

describe("model request failures", () => {
  it("does not confuse a bare 429 with confirmed quota exhaustion or rate limiting", () => {
    const unknown = classifyProviderFailure("deepseek", { httpStatusCode: 429 })!;
    expect(unknown.limitType).toBe("unknown");
    expect(providerFailureCopy(unknown).message).toContain("不能确认");
    expect(classifyProviderFailure("deepseek", { error: { code: "QuotaExceeded.CodingPlanQuotaExceeded", httpStatusCode: 429 } })?.limitType).toBe("quota");
    expect(classifyProviderFailure("deepseek", { error: { code: "RateLimitExceeded.EndpointTPMExceeded", httpStatusCode: 429 } })?.limitType).toBe("rate");
  });
  it("surfaces GPT response stream failures instead of silently ignoring them", () => {
    expect(classifyProviderFailure("gpt-6.1-sol", { message: "stream disconnected before completion: stream closed before response.completed" }))
      .toMatchObject({ kind: "stream", model: "gpt-6.1-sol", httpStatusCode: null });
  });
  it("keeps quota and ordinary request failures distinct for every provider", () => {
    expect(classifyProviderFailure("deepseek-v4-1-flash-261017", { code: "[object Object]", message: "本轮处理失败", originalMessage: "exceeded retry limit, last status: 429 Too Many Requests, request id: example" })).toMatchObject({ kind: "limit", httpStatusCode: 429 });
    expect(classifyProviderFailure("gpt-6.1-sol", { codexErrorInfo: { httpStatusCode: 429 } })?.kind).toBe("limit");
    expect(classifyProviderFailure("doubao-seed", { message: "bad request" })?.kind).toBe("request");
    expect(classifyProviderFailure("", {})).toBeNull();
  });
  it("does not blame the selected model for local session recovery gating", () => {
    expect(classifyProviderFailure("gpt-6.1-sol", "该会话的连接已中断，但 Codex 尚未卸载运行时")).toBeNull();
    expect(classifyProviderFailure("gpt-6.1-sol", { message: "会话仍在运行或等待批准，不能重新载入" })).toBeNull();
  });
  it("only calls it capacity when the upstream explicitly says so", () => {
    expect(classifyProviderFailure("gpt-6-sol", { message: "Model at capacity. Please use another model." })?.kind).toBe("capacity");
    const notice = classifyProviderFailure("gpt-6-sol", { message: "stream disconnected", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } })!;
    expect(notice.kind).toBe("unavailable");
    expect(providerFailureCopy(notice).message).toContain("可能");
    expect(providerFailureCopy(notice).message).not.toContain("model at capacity");
  });
  it("handles textual 503 and authentication separately and keeps readable details", () => {
    expect(classifyProviderFailure("gpt-6-sol", "HTTP 503 Service Unavailable")?.httpStatusCode).toBe(503);
    expect(classifyProviderFailure("gpt-6-sol", { message: "refresh_token_reused", httpStatusCode: 401 })?.kind).toBe("auth");
    expect(classifyProviderFailure("gpt-6-sol", { message: "stream disconnected" })?.detail).toBe("stream disconnected");
  });
});
