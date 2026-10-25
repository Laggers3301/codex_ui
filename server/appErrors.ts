import { modelErrorDetails, modelErrorSummary, redactModelError } from "../shared/modelError.js";
export interface PublicAppError { code: string; message: string; originalMessage: string; retryable: boolean; at: string }

function safeMessage(value: unknown): string {
  return redactModelError(typeof value === "string" ? value : modelErrorDetails(value).message);
}

export class AppError extends Error {
  constructor(public code: string, message: string, public originalMessage = message, public retryable = false) { super(message); this.name = "AppError"; }
  toPublic(): PublicAppError {
    const detail = modelErrorSummary(this.originalMessage);
    const message = detail && detail !== this.message && detail !== "未知错误" ? `${this.message} 具体原因：${detail}` : this.message;
    return { code: this.code, message, originalMessage: safeMessage(this.originalMessage), retryable: this.retryable, at: new Date().toISOString() };
  }
  static from(value: unknown): AppError {
    if (value instanceof AppError) return value;
    const { message: original, code: nativeCode, signature, status } = modelErrorDetails(value);
    // Quota and credential failures must never enter a transient retry loop.
    if (/AccountQuotaExceeded|insufficient[_ .]quota|\bquota[_ .]?exceeded\b|usage_?limit|credits|balance.insufficient/i.test(signature)) return new AppError("quota_exceeded", "供应商额度已用尽或达到套餐上限，请等待额度重置或更换供应商。", original);
    if (status === 401 || /unauthorized|authentication|invalid.*token/i.test(signature)) return new AppError("authentication_failed", "账号认证失败，请查看错误详情。", original);
    if (/RequestBurstTooFast|SessionQuotaExceeded|(?:rpm|tpm|concurrency)[_ .]?limit|rate[_ .]?limit[_ .]?exceeded/i.test(signature)) return new AppError("rate_limited", "供应商暂时限制请求频率或并发，正在按重试策略等待恢复。", original, true);
    if (/server_?overloaded|selected model is at capacity/i.test(signature)) return new AppError("model_overloaded", "模型服务暂时过载，已完成的步骤会沿用。", original, true);
    // A bare 429 does not reveal quota vs RPM/TPM. Do not invent a cause or
    // automatically repeat an already exhausted native retry sequence.
    if (status === 429) return new AppError("upstream_http_429", "供应商返回 HTTP 429，当前请求受限。请查看套餐额度或稍后重试；现有错误未说明具体限额类型。", original);
    if (/memory_pressure/i.test(signature)) return new AppError("memory_pressure", "运行资源不足，任务已暂停。请稍后继续。", original);
    if (/runtime_terminated|app-server exited/i.test(signature)) return new AppError("runtime_terminated", "运行进程意外退出，请查看错误详情后继续。", original);
    if (/usage_?limit|quota|credits|rate limit/i.test(signature)) return new AppError("quota_or_rate_limit", "服务额度或请求频率受限，请查看错误详情。", original);
    if (/401\b/i.test(signature)) return new AppError("authentication_failed", "账号认证失败，请查看错误详情。", original);
    if (/context.*(exhaust|exceed|full)|CONTEXT_EXHAUSTED/i.test(signature)) return new AppError("context_exhausted", "会话上下文已满，请使用续接会话。", original);
    if (/stream[_ ]disconnected|stream.*before completion|peer closed connection/i.test(signature)) return new AppError("stream_disconnected", "模型连接意外中断，正在按重试策略尝试恢复；已完成的步骤会保留。", original, true);
    return new AppError(nativeCode || "request_failed", "本轮处理失败，请查看错误详情。", original);
  }
}
