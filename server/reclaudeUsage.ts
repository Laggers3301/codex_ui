import fs from "node:fs";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./appErrors.js";
import type { ClaudeBinding } from "./claudeBindings.js";
import { remainingTime, type ReclaudeAccountUsage, type ReclaudeUsageWindow } from "../shared/reclaudeUsage.js";

const THRESHOLD = 99;
const weekly = (kind: string) => kind === "seven_day" || kind.startsWith("seven_day_") || kind === "model_weekly";
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function timestamp(v: unknown): number | null {
  if (typeof v === "string") { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return finite(v) ? (v < 1e11 ? v * 1000 : v) : null;
}

/** Only consumes data already returned by ReClaude. No network client is
 * present: in particular this class cannot call Claude's usage/sync APIs. */
export class ReclaudeUsageMonitor {
  cacheError?: string;
  constructor(private db: DatabaseSync, private onDisabled: (accountKey: string, message: string) => void,
    private now = Date.now) {
    db.exec("CREATE TABLE IF NOT EXISTS reclaude_usage (account_key TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(account_key,kind))");
  }
  private save(accountKey: string, window: ReclaudeUsageWindow) {
    const old = this.windows(accountKey).find(value => value.kind === window.kind);
    if (old && old.observedAt > window.observedAt) return;
    // An older/lower cached observation must not release a latched 99% stop.
    // Only a strictly newer reset window (or confirmed fresh data after reset)
    // can start a new budget. Unknown reset times stay blocked.
    if (old && old.percent >= THRESHOLD && window.percent < THRESHOLD
      && (!old.resetsAt || this.now() < old.resetsAt || window.observedAt < old.resetsAt)) return;
    this.db.prepare("INSERT INTO reclaude_usage VALUES (?,?,?) ON CONFLICT(account_key,kind) DO UPDATE SET body=excluded.body")
      .run(accountKey, window.kind, JSON.stringify(window));
    if (weekly(window.kind) && window.percent >= THRESHOLD && (!window.resetsAt || window.resetsAt > this.now())) {
      this.onDisabled(accountKey, this.reason(window));
    }
  }
  observeResponse(accountKey: string, event: unknown) {
    const message = record(event), info = record(message.rate_limit_info ?? message);
    const observedAt = this.now();
    // Current Claude CLI exposes every observed header window here. The
    // top-level field can describe only the most restrictive (often 5h) one.
    const windows = { ...record(info.unifiedWindows) };
    if (typeof info.rateLimitType === "string" && finite(info.utilization)) windows[info.rateLimitType] = info;
    for (const [kind, raw] of Object.entries(windows)) {
      const value = record(raw);
      if (!["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"].includes(kind) || !finite(value.utilization)) continue;
      this.save(accountKey, { kind, percent: Math.round(value.utilization * 10_000) / 100,
        resetsAt: timestamp(value.resetsAt), observedAt, source: "response" });
    }
  }
  /** Trusted local export: {accounts:[{accountUuid, observedAt, usage_snapshot}]}.
   * Bind by actual Claude UUID; an org id or ReClaude login is insufficient.
   * Only usage fields enter SQLite; credentials/raw account objects do not. */
  readCache(file: string, bindings: ClaudeBinding[]) {
    try {
      if (!file.startsWith("/") || fs.statSync(file).size > 1024 * 1024) throw new Error("invalid cache");
      const input = record(JSON.parse(fs.readFileSync(file, "utf8")));
      for (const raw of Array.isArray(input.accounts) ? input.accounts : []) {
        const row = record(raw);
        if (typeof row.accountUuid !== "string" || !row.accountUuid) continue;
        const key = createHash("sha256").update(row.accountUuid).digest("hex");
        if (!bindings.some(binding => binding.accountKey === key)) continue;
        const observedAt = timestamp(row.observedAt);
        if (!observedAt || observedAt > this.now() + 60_000) continue;
        for (const [kind, rawWindow] of Object.entries(record(row.usage_snapshot))) {
          const window = record(rawWindow);
          if ((!weekly(kind) && kind !== "five_hour") || !finite(window.utilization)) continue;
          this.save(key, { kind, percent: window.utilization, resetsAt: timestamp(window.resets_at), observedAt, source: "reclaude-cache" });
        }
      }
      this.cacheError = undefined;
    } catch { this.cacheError = "ReClaude 本地用量缓存暂不可读；保留已知停用状态，继续监听正常响应中的用量。"; }
  }
  windows(key: string): ReclaudeUsageWindow[] {
    return (this.db.prepare("SELECT body FROM reclaude_usage WHERE account_key=?").all(key) as Array<{body:string}>)
      .map(row => JSON.parse(row.body)).sort((a,b) => a.kind.localeCompare(b.kind));
  }
  private reason(window: ReclaudeUsageWindow) {
    const seconds = window.resetsAt ? Math.max(0, Math.ceil((window.resetsAt - this.now()) / 1000)) : null;
    return `此 Claude 账号周用量已达 ${window.percent}%（停用阈值 ${THRESHOLD}%），已自动停用 ReClaude。${seconds === null ? "上游未提供重置时间，需等待新的可用额度数据。" : `还需等待 ${remainingTime(seconds)}，到上游返回的重置时间后重新监测。`}可迁移到其它可用账号或 Codex。`;
  }
  status(binding: ClaudeBinding): ReclaudeAccountUsage {
    const windows = this.windows(binding.accountKey);
    // A reported reset timestamp bounds that particular weekly window. After
    // it expires, mark usage unknown until a new response, never display 0%.
    const current = windows.filter(w => !w.resetsAt || w.resetsAt > this.now());
    const blocked = current.filter(w => weekly(w.kind) && w.percent >= THRESHOLD)
      .sort((a,b) => (b.resetsAt ?? Infinity) - (a.resetsAt ?? Infinity))[0];
    const known = current.some(w => weekly(w.kind));
    return { orgId: binding.orgId, label: binding.label, state: blocked ? "disabled" : known ? "available" : "unknown", windows,
      message: blocked ? this.reason(blocked) : known ? "自动读取 ReClaude 正常响应中的用量；未主动同步上游用量。" : "尚未收到周用量数据，不能视为 0%；首次正常响应后自动更新。",
      retryAfterSeconds: blocked?.resetsAt ? Math.max(0, Math.ceil((blocked.resetsAt - this.now()) / 1000)) : null };
  }
  assertAvailable(binding: ClaudeBinding) {
    const status = this.status(binding);
    if (status.state === "disabled") throw new AppError("claude_weekly_limit", status.message);
  }
}
