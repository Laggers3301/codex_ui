import { expect, it } from "vitest";
import { AppError } from "./appErrors.js";
import { modelErrorDetails } from "../shared/modelError.js";

it("shows native structured HTTP 429 without object coercion or guessing quota exhaustion", () => {
  const error = AppError.from({ message: "exceeded retry limit, last status: 429 Too Many Requests, request id: example-id", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }).toPublic();
  expect(error).toMatchObject({ code: "upstream_http_429", retryable: false });
  expect(error.message).toContain("具体限额类型");
  expect(error.originalMessage).toContain("example-id");
  expect(JSON.stringify(error)).not.toContain("[object Object]");
});
it("distinguishes confirmed quota, transient throttling and overloaded HTTP 429", () => {
  for (const code of ["AccountQuotaExceeded", "UsageLimitExceeded", "insufficient_quota"]) {
    expect(AppError.from({ error: { code, message: "limit", httpStatusCode: 429 } })).toMatchObject({ code: "quota_exceeded", retryable: false });
  }
  for (const code of ["RequestBurstTooFast", "SessionQuotaExceeded", "ModelAccountTpmRateLimitExceeded"]) {
    expect(AppError.from({ error: { code, message: "limited", httpStatusCode: 429 } })).toMatchObject({ code: "rate_limited", retryable: true });
  }
  expect(AppError.from({ error: { code: "ServerOverloaded", httpStatusCode: 429 } })).toMatchObject({ code: "model_overloaded", retryable: true });
  expect(AppError.from({ code: "quota_or_rate_limit", message: "quota exceeded" }).retryable).toBe(false);
});
it("redacts nested errors and never serializes headers, requests or unknown fields", () => {
  const raw = { error: { code: "Unauthorized", message: 'Bearer top-secret api_key="secret-value" ark-123456789012345' }, headers: { Authorization: "header-secret" }, request: { body: "prompt-secret" }, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } };
  const details = modelErrorDetails(raw);
  expect(details.status).toBe(503);
  for (const secret of ["top-secret", "secret-value", "123456789012345", "header-secret", "prompt-secret"]) expect(JSON.stringify(details)).not.toContain(secret);
  expect(AppError.from(raw).retryable).toBe(false);
});
it("handles cyclic errors and recovers old persisted object-coercion failures", () => {
  const error: Record<string, unknown> = { message: { error: { message: "HTTP 503", code: "ServiceUnavailable" } } };
  error.cause = error;
  expect(modelErrorDetails(error)).toMatchObject({ code: "ServiceUnavailable", status: 503 });
  expect(modelErrorDetails({ code: "[object Object]", message: "本轮处理失败", originalMessage: "exceeded retry limit, last status: 429 Too Many Requests" })).toMatchObject({ code: "http_429", status: 429 });
});
