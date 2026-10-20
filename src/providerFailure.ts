export type ProviderFailureNotice = {
  kind: "capacity" | "unavailable" | "auth" | "limit" | "stream" | "request";
  model: string;
  httpStatusCode: number | null;
  detail?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function classifyProviderFailure(model: string, rawError: unknown): ProviderFailureNotice | null {
  if (!model) return null;
  const error = record(rawError);
  const info = record(error.codexErrorInfo);
  const message = typeof rawError === "string" ? rawError : String(error.originalMessage ?? error.message ?? "");
  const status = [info.httpStatusCode, error.httpStatusCode, ...Object.values(info).map(value => record(value).httpStatusCode)].find((value) => typeof value === "number");
  const messageStatus = message.match(/(?:HTTP(?:\s+status)?|status(?:_code)?[=:]?|503\s+Service\s+Unavailable)\s*(\d{3})?/i);
  const httpStatusCode = typeof status === "number" ? status : messageStatus?.[1] ? Number(messageStatus[1]) : /503\s+Service\s+Unavailable/i.test(message) ? 503 : null;
  const classification = `${JSON.stringify(error.codexErrorInfo ?? "")} ${String(error.code ?? "")} ${String(error.message ?? "")} ${message}`;
  // Session gating is a local error, not a failed model/credit request.
  if (/尚未卸载运行时|会话仍在运行或等待批准|取消订阅不等于立即卸载/.test(classification)) return null;
  const limit = /UsageLimitExceeded|insufficient.quota|quota.exceeded|balance.insufficient|billing|额度|余额不足|配额|限流|频率限制/i.test(classification)
    || httpStatusCode === 402 || httpStatusCode === 429;
  const disconnected = /ResponseStreamDisconnected|ResponseStreamConnectionFailed|stream disconnected|stream closed before response.completed/i.test(classification);
  const capacity = /model.{0,30}(?:at capacity|overloaded)|model_at_capacity|capacity_exceeded|Please use another model/i.test(classification);
  const unavailable = httpStatusCode === 503 || /service unavailable|temporarily unavailable/i.test(classification);
  const auth = httpStatusCode === 401 || /refresh_token_reused|refresh_token_invalidated|authentication_token|unauthorized/i.test(classification);
  return { kind: capacity ? "capacity" : auth ? "auth" : limit ? "limit" : unavailable ? "unavailable" : disconnected ? "stream" : "request", model, httpStatusCode,
    ...(message ? { detail: message.slice(0, 2000) } : {}) };
}

export function providerFailureCopy(notice: ProviderFailureNotice): { title: string; message: string } {
  const model = notice.model;
  switch (notice.kind) {
    case "capacity": return { title: "模型繁忙，暂时无法接单", message: `${model} 返回 model at capacity。请切换其他模型，或稍后重试。` };
    case "unavailable": return { title: "上游服务暂时不可用", message: `${model} 返回服务不可用${notice.httpStatusCode ? `（HTTP ${notice.httpStatusCode}）` : ""}，可能是服务拥塞或临时故障。请稍后重试，或选择其他模型；不等于账号登录失效。` };
    case "auth": return { title: "账号授权异常", message: `${model} 的请求未通过身份验证，请检查对应账号的登录状态。切换模型不一定能解决。` };
    case "limit": return { title: "额度或请求频率受限", message: `${model} 返回额度或限流错误。请查看额度；若是请求过于频繁，请稍后重试。` };
    case "stream": return { title: "回答连接中断，本轮未完成", message: `${model} 的响应流在完成前断开。可能是上游故障或连接问题，请稍后重试；持续失败时可选择其他模型。` };
    default: return { title: "本轮请求失败", message: `${model} 未能完成回答，具体原因请查看错误详情。可以稍后重试；持续失败时可选择其他模型。` };
  }
}
