import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "./providerFailure";

describe("model request failures", () => {
  it("surfaces GPT response stream failures instead of silently ignoring them", () => {
    expect(classifyProviderFailure("gpt-6.1-sol", { message: "stream disconnected before completion: stream closed before response.completed" }))
      .toEqual({ kind: "stream", model: "gpt-6.1-sol", httpStatusCode: null });
  });
  it("keeps quota and ordinary request failures distinct for every provider", () => {
    expect(classifyProviderFailure("gpt-6.1-sol", { codexErrorInfo: { httpStatusCode: 429 } })?.kind).toBe("limit");
    expect(classifyProviderFailure("doubao-seed", { message: "bad request" })?.kind).toBe("request");
    expect(classifyProviderFailure("", {})).toBeNull();
  });
  it("does not blame the selected model for local session recovery gating", () => {
    expect(classifyProviderFailure("gpt-6.1-sol", "该会话的连接已中断，但 Codex 尚未卸载运行时")).toBeNull();
    expect(classifyProviderFailure("gpt-6.1-sol", { message: "会话仍在运行或等待批准，不能重新载入" })).toBeNull();
  });
});
