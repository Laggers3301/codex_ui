import { expect, it } from "vitest";
import { AppError } from "./appErrors.js";
import { modelErrorDetails } from "../shared/modelError.js";

it.each([
  'Command failed: claude-launch-reclaude auth status; Syncing config...; Get "https://cloudfront.reclaude.ai/client/account": context deadline exceeded',
  'context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
  {code:'ETIMEDOUT',message:'connect timeout'},
  'TLS handshake timed out',
  'Timed out waiting for Codex response to turn/start.'
])('classifies request deadlines as connection timeouts, without replaying an uncertain submission: %j',raw=>{
  const error=AppError.from(raw).toPublic();
  expect(error).toMatchObject({code:'request_timeout',source:'connection',retryable:false});
  expect(error.message).toContain('请求超时');expect(error.message).not.toContain('上下文已满');
  expect(error.originalMessage).toBe(modelErrorDetails(raw).message);
  expect(AppError.from(JSON.parse(JSON.stringify(error))).toPublic()).toMatchObject({code:'request_timeout',source:'connection',retryable:false});
});
it('corrects a previously serialized context misclassification when the original reason is a deadline',()=>{
  expect(AppError.from({code:'context_exhausted',message:'会话上下文已满，请使用续接会话。',originalMessage:'Get "https://example.test/account": context deadline exceeded'})).toMatchObject({code:'request_timeout',source:'connection',retryable:false});
});
it.each(['CONTEXT_EXHAUSTED','ContextWindowExceeded','context_length_exceeded','maximum context length exceeded','context window is full','Prompt is too long','上下文长度超过上限'])('retains genuine context overflow classification: %s',message=>{
  expect(AppError.from({message})).toMatchObject({code:'context_exhausted',retryable:false});
});
it('does not infer a full model context from an unrelated context and exceeded pair',()=>{
  expect(AppError.from({message:'context: connection attempt exceeded its deadline'}).code).not.toBe('context_exhausted');
});

it("recognizes native stream failure enum spellings without readable English text", () => {
  for (const info of ["ResponseStreamDisconnected", "ResponseStreamConnectionFailed", "response_stream_disconnected", { responseStreamDisconnected: { httpStatusCode: 503 } }, { responseStreamConnectionFailed: {} }]) {
    expect(AppError.from({ message: "连接异常", codexErrorInfo: info })).toMatchObject({ code: "stream_disconnected", retryable: true });
  }
  expect(AppError.from(new Error("Timed out waiting for Codex response to turn/start.")).retryable).toBe(false);
});

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
it.each(["claude_five_hour_limit","claude_weekly_limit"])("preserves %s across socket, recovery and stored error serialization",code=>{
  const publicError=new AppError(code,"此 Claude 账号已达到额度阈值，等待重置。").toPublic();
  expect(AppError.from(JSON.parse(JSON.stringify(publicError))).toPublic()).toMatchObject({code,retryable:false,source:"provider",message:expect.stringContaining("等待重置")});
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
it("includes a specific redacted reason in the public message, including weekly reset", () => {
  const result=AppError.from({error:{code:"AccountQuotaExceeded",message:"You have exceeded the weekly usage quota. It will reset at 2026-10-26 00:00:00 +0800 CST."}}).toPublic();
  expect(result.message).toContain("每周额度已耗尽");
  expect(result.message).toContain("2026-10-26 00:00:00 +0800");
  const other=AppError.from({message:"Unsupported image format; Bearer secret123 https://example.test/?token=private123"}).toPublic();
  expect(other.message).toContain("Unsupported image format");
  expect(JSON.stringify(other)).not.toMatch(/secret123|private123/);
});
