export interface PublicAppError { code: string; message: string; originalMessage: string; retryable: boolean; at: string }

function safeMessage(value: unknown): string {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : "未知错误";
  return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [已隐藏]")
    .replace(/\b(sk-[\w-]{12,}|(?:access_token|refresh_token|api_key|password)\s*[=:]\s*[^\s,;"']+)/gi, "[凭据已隐藏]").slice(0, 4000);
}

export class AppError extends Error {
  constructor(public code: string, message: string, public originalMessage = message, public retryable = false) { super(message); this.name = "AppError"; }
  toPublic(): PublicAppError { return { code: this.code, message: this.message, originalMessage: safeMessage(this.originalMessage), retryable: this.retryable, at: new Date().toISOString() }; }
  static from(value: unknown): AppError {
    if (value instanceof AppError) return value;
    const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const original = safeMessage(row.message ?? value);
    const nativeCode = String(row.code ?? row.codexErrorInfo ?? row.codex_error_info ?? "");
    const signature = `${nativeCode} ${original}`;
    if (/server_?overloaded|selected model is at capacity/i.test(signature)) return new AppError("model_overloaded", "模型服务暂时过载，已完成的步骤会沿用。", original, true);
    if (/memory_pressure/i.test(signature)) return new AppError("memory_pressure", "运行资源不足，任务已暂停。请稍后继续。", original);
    if (/runtime_terminated|app-server exited/i.test(signature)) return new AppError("runtime_terminated", "运行进程意外退出，请查看错误详情后继续。", original);
    if (/usage_?limit|quota|credits|rate limit/i.test(signature)) return new AppError("quota_or_rate_limit", "服务额度或请求频率受限，请查看错误详情。", original);
    if (/unauthorized|authentication|invalid.*token|401\b/i.test(signature)) return new AppError("authentication_failed", "账号认证失败，请查看错误详情。", original);
    if (/context.*(exhaust|exceed|full)|CONTEXT_EXHAUSTED/i.test(signature)) return new AppError("context_exhausted", "会话上下文已满，请使用续接会话。", original);
    return new AppError(nativeCode || "request_failed", "本轮处理失败，请查看错误详情。", original);
  }
}
