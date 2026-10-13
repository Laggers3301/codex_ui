export type ProviderFailureNotice = {
  kind: "limit" | "stream" | "request";
  model: string;
  httpStatusCode: number | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function classifyProviderFailure(model: string, rawError: unknown): ProviderFailureNotice | null {
  if (!model) return null;
  const error = record(rawError);
  const info = record(error.codexErrorInfo);
  const status = [info.httpStatusCode, error.httpStatusCode].find((value) => typeof value === "number");
  const httpStatusCode = typeof status === "number" ? status : null;
  const classification = `${JSON.stringify(error.codexErrorInfo ?? "")} ${typeof rawError === "string" ? rawError : String(error.message ?? "")}`;
  // Session gating is a local error, not a failed model/credit request.
  if (/尚未卸载运行时|会话仍在运行或等待批准|取消订阅不等于立即卸载/.test(classification)) return null;
  const limit = /UsageLimitExceeded|insufficient.quota|quota.exceeded|balance.insufficient|billing|额度|余额不足|配额|限流|频率限制/i.test(classification)
    || httpStatusCode === 402 || httpStatusCode === 429;
  const disconnected = /ResponseStreamDisconnected|ResponseStreamConnectionFailed|stream disconnected|stream closed before response.completed/i.test(classification);
  return { kind: limit ? "limit" : disconnected ? "stream" : "request", model, httpStatusCode };
}
