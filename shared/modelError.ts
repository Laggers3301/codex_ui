/** Bounded, allow-listed extraction: never stringify an upstream error object
 * (it may contain request bodies, headers or credentials). Shared by both UIs. */
export function redactModelError(text: string): string {
  return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [已隐藏]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[凭据已隐藏]@")
    .replace(/([?&](?:token|key|secret|code|access_token|refresh_token|api_key)=)[^\s&#"']+/gi, "$1[已隐藏]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[凭据已隐藏]")
    .replace(/\b(?:sk-|ark-|tp-)[\w-]{12,}/gi, "[凭据已隐藏]")
    .replace(/((?:access_token|refresh_token|api_key|password|authorization)["']?\s*[=:]\s*["']?)[^\s,;"'}]+/gi, "$1[已隐藏]")
    .slice(0, 4000);
}

export function modelErrorDetails(value: unknown): { code: string; message: string; status: number | null; signature: string } {
  const messages: string[] = [], codes: string[] = [];
  const seen = new Set<object>();
  let status: number | null = null, requestId = "", visits = 0;
  const visit = (input: unknown, depth: number, enumValue = false): void => {
    if (depth > 5 || ++visits > 40) return;
    if (typeof input === "string") {
      if (input && input !== "[object Object]") {
        // Some transports preserve an upstream JSON error as a string.
        if (input.length <= 16_384 && /^\s*\{/.test(input)) {
          try { const parsed = JSON.parse(input); if (parsed && typeof parsed === "object") { visit(parsed, depth + 1); return; } } catch { /* Retain readable text. */ }
        }
        messages.push(input.slice(0, 4000));
      }
      return;
    }
    if (!input || typeof input !== "object" || seen.has(input)) return;
    seen.add(input);
    const row = input as Record<string, unknown>;
    if (typeof row.code === "string" && /^[\w.-]{1,120}$/.test(row.code)) codes.push(row.code);
    for (const key of ["httpStatusCode", "statusCode", "status_code", "status"]) {
      const n = row[key];
      if (status === null && typeof n === "number" && n >= 400 && n <= 599) status = n;
    }
    for (const key of ["requestId", "request_id"]) {
      if (!requestId && typeof row[key] === "string" && /^[\w.-]{1,160}$/.test(row[key] as string)) requestId = row[key] as string;
    }
    for (const key of ["originalMessage", "message", "error", "cause", "details"]) visit(row[key], depth + 1);
    for (const key of ["codexErrorInfo", "codex_error_info"]) {
      const info = row[key];
      if (typeof info === "string" && /^[\w.-]{1,120}$/.test(info)) codes.push(info);
      else visit(info, depth + 1, true);
    }
    if (enumValue) for (const [key, nested] of Object.entries(row).slice(0, 8)) {
      if (/^(?:http|response|stream|server|usage|context|other|badRequest|sandbox|thread|internal|unauthorized|rate)[\w]*$/.test(key) && !["httpStatusCode", "message", "code", "status"].includes(key)) {
        codes.push(key);
        if (nested && typeof nested === "object") visit(nested, depth + 1);
      }
    }
  };
  visit(value, 0);
  const raw = [...new Set(messages)].join("\n");
  const match = raw.match(/(?:HTTP(?:\s+status)?|(?:last\s+)?status(?:_code)?\s*[:=]?|\b)([45]\d\d)\s+(?:Too Many Requests|Unauthorized|Forbidden|Service Unavailable|Bad Gateway|Internal Server Error)/i)
    ?? raw.match(/(?:HTTP(?:\s+status)?|status(?:_code)?\s*[:=]?)\s*([45]\d\d)\b/i);
  if (status === null && match) status = Number(match[1]);
  const code = codes.find(c => c !== "request_failed" && redactModelError(c) === c) ?? (status ? `http_${status}` : "request_failed");
  const message = redactModelError([raw || (status ? `HTTP ${status}` : "未知错误"), requestId && !raw.includes(requestId) ? `request id: ${requestId}` : ""].filter(Boolean).join("\n"));
  return { code, message, status, signature: redactModelError(`${codes.join(" ")} ${message}`) };
}

/** Short, safe banner copy. Unknown errors keep the actual upstream reason. */
export function modelErrorSummary(value: unknown): string {
  const { message, signature } = modelErrorDetails(value);
  const weekly = /weekly.{0,35}(?:quota|limit)|(?:quota|limit).{0,35}weekly/i.test(signature);
  const reset = message.match(/(?:reset(?:s|ting)?(?:\s+at)?|重置(?:时间)?[：:]?)\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\s*(?:[+-]\d{2}:?\d{2}|Z))?)/i)?.[1];
  if (weekly && /exceed|exhaust|耗尽|用尽|上限/i.test(signature)) {
    return `每周额度已耗尽${reset ? `；重置时间：${reset}${/\+0800|\+08:00/.test(reset) ? "（北京时间）" : ""}` : "，请等待重置或切换供应商"}。`;
  }
  return message.replace(/(?:request[ _-]?id\s*[:=]\s*)[\w.-]+/gi, "")
    .split("\n").map(s => s.trim()).filter(Boolean).filter((s,i,a)=>a.indexOf(s)===i).join("；").replace(/\s+/g," ").slice(0, 360);
}
