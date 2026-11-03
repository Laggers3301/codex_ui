/** Only accept explicit short descriptions; never infer intent from arbitrary output. */
export function toolDescription(...values: unknown[]): string | undefined {
  for (const value of values) {
    let record = value;
    if (typeof record === "string" && record.length <= 64000 && record.trim().startsWith("{")) {
      try { record = JSON.parse(record); } catch { continue; }
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const description = (record as Record<string, unknown>).description;
    if (typeof description !== "string") continue;
    const text = description.replace(/\s+/g, " ").trim();
    if (text && text.length <= 240 && !/[\u0000-\u001f]/.test(text)) return text;
  }
  return undefined;
}
