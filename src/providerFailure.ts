export type ProviderFailureNotice = {
  kind: "limit" | "request";
  model: string;
  httpStatusCode: number | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function classifyProviderFailure(model: string, rawError: unknown): ProviderFailureNotice | null {
  if (!model || model.startsWith("gpt-")) return null;
  const error = record(rawError);
  const info = record(error.codexErrorInfo);
  const status = [info.httpStatusCode, error.httpStatusCode].find((value) => typeof value === "number");
  const httpStatusCode = typeof status === "number" ? status : null;
  const classification = `${JSON.stringify(error.codexErrorInfo ?? "")} ${typeof rawError === "string" ? rawError : String(error.message ?? "")}`;
  const limit = /UsageLimitExceeded|insufficient.quota|quota.exceeded|balance.insufficient|billing|额度|余额不足|配额|限流|频率限制/i.test(classification)
    || httpStatusCode === 402 || httpStatusCode === 429;
  return { kind: limit ? "limit" : "request", model, httpStatusCode };
}
