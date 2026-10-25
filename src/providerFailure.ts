import { modelErrorDetails, modelErrorSummary } from "../shared/modelError";
export type ProviderFailureNotice = {
  kind: "capacity" | "unavailable" | "auth" | "limit" | "stream" | "request";
  model: string;
  httpStatusCode: number | null;
  detail?: string;
  limitType?: "quota" | "rate" | "unknown";
};

export function classifyProviderFailure(model: string, rawError: unknown): ProviderFailureNotice | null {
  if (!model) return null;
  const { message, status: httpStatusCode, signature: classification } = modelErrorDetails(rawError);
  // Session gating is a local error, not a failed model/credit request.
  if (/尚未卸载运行时|会话仍在运行或等待批准|取消订阅不等于立即卸载/.test(classification)) return null;
  const limit = /UsageLimitExceeded|insufficient.quota|quota.exceeded|balance.insufficient|billing|额度|余额不足|配额|限流|频率限制/i.test(classification)
    || httpStatusCode === 402 || httpStatusCode === 429;
  const disconnected = /ResponseStreamDisconnected|ResponseStreamConnectionFailed|stream disconnected|stream closed before response.completed/i.test(classification);
  const capacity = /model.{0,30}(?:at capacity|overloaded)|model_at_capacity|capacity_exceeded|Please use another model/i.test(classification);
  const unavailable = httpStatusCode === 503 || /service unavailable|temporarily unavailable/i.test(classification);
  const auth = httpStatusCode === 401 || /refresh_token_reused|refresh_token_invalidated|authentication_token|unauthorized/i.test(classification);
  return { kind: capacity ? "capacity" : auth ? "auth" : limit ? "limit" : unavailable ? "unavailable" : disconnected ? "stream" : "request", model, httpStatusCode,
    ...(limit ? { limitType: /AccountQuotaExceeded|QuotaExceeded|UsageLimitExceeded|insufficient[_ .]quota|balance.insufficient/i.test(classification) ? "quota" as const : /RequestBurstTooFast|RateLimitExceeded|SessionQuotaExceeded|rate_limited|(?:rpm|tpm|concurrency)[_ .]?limit/i.test(classification) ? "rate" as const : "unknown" as const } : {}),
    ...(message ? { detail: message.slice(0, 2000) } : {}) };
}

function fallbackProviderFailureCopy(notice: ProviderFailureNotice): { title: string; message: string } {
  const model = notice.model;
  switch (notice.kind) {
    case "capacity": return { title: "模型繁忙，暂时无法接单", message: `${model} 返回 model at capacity。请切换其他模型，或稍后重试。` };
    case "unavailable": return { title: "上游服务暂时不可用", message: `${model} 返回服务不可用${notice.httpStatusCode ? `（HTTP ${notice.httpStatusCode}）` : ""}，可能是服务拥塞或临时故障。请稍后重试，或选择其他模型；不等于账号登录失效。` };
    case "auth": return { title: "账号授权异常", message: `${model} 的请求未通过身份验证，请检查对应账号的登录状态。切换模型不一定能解决。` };
    case "limit": return notice.limitType === "quota"
      ? { title: "供应商额度已达上限", message: `${model} 返回套餐额度不足，请等待重置或切换供应商。` }
      : notice.limitType === "rate" ? { title: "请求频率或并发受限", message: `${model} 暂时限流，请稍后重试；不代表套餐额度用尽。` }
      : { title: `请求受限${notice.httpStatusCode ? ` · HTTP ${notice.httpStatusCode}` : ""}`, message: `${model} 未返回具体限额类型；仅凭状态码不能确认额度耗尽或限频，请查看错误详情。` };
    case "stream": return { title: "回答连接中断，本轮未完成", message: `${model} 的响应流在完成前断开。可能是上游故障或连接问题，请稍后重试；持续失败时可选择其他模型。` };
    default: return { title: "本轮请求失败", message: `${model} 未能完成回答，具体原因请查看错误详情。可以稍后重试；持续失败时可选择其他模型。` };
  }
}

export function providerFailureCopy(notice: ProviderFailureNotice): { title: string; message: string } {
  const copy = fallbackProviderFailureCopy(notice);
  if (!notice.detail) return copy;
  const detail = modelErrorSummary(notice.detail);
  if (/每周额度已耗尽/.test(detail)) return { title: "每周额度已耗尽", message: `${notice.model}：${detail}` };
  if (detail && !/^HTTP \d{3}$|^未知错误$/.test(detail)) return { ...copy, message: `${copy.message} 原因：${detail}` };
  return copy;
}
