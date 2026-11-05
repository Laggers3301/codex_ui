import fs from "node:fs";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./appErrors.js";
import type { ClaudeBinding } from "./claudeBindings.js";
import { isReclaudeWeeklyWindow, reclaudeWindowActive, reclaudeWindowThreshold, remainingTime, type ReclaudeAccountUsage, type ReclaudeLimitCode, type ReclaudeUsageWindow } from "../shared/reclaudeUsage.js";

const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function timestamp(v: unknown): number | null {
  if (typeof v === "string") { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return finite(v) ? (v < 1e11 ? v * 1000 : v) : null;
}

export class ReclaudeUsageLimitError extends AppError {
  declare code: ReclaudeLimitCode;
  readonly retryAt: string | null;
  readonly retryAfterSeconds: number | null;
  constructor(window: ReclaudeUsageWindow, now: number) {
    const weekly = isReclaudeWeeklyWindow(window.kind);
    const seconds = window.resetsAt ? Math.max(0, Math.ceil((window.resetsAt - now) / 1000)) : null;
    const reason = weekly
      ? `此 Claude 账号周用量已达 ${window.percent}%（停用阈值 99%），已自动停用 ReClaude。`
      : `此 Claude 账号 5 小时用量已达 ${window.percent}%（上限 100%），已暂停使用此账号。`;
    const wait = seconds === null ? "上游未提供重置时间，需等待新的可用额度数据。"
      : `还需等待 ${remainingTime(seconds)}，到上游返回的重置时间后重新监测。`;
    super(weekly ? "claude_weekly_limit" : "claude_five_hour_limit", `${reason}${wait}可迁移到其它可用账号或 Codex。`);
    this.retryAfterSeconds = seconds;
    this.retryAt = window.resetsAt ? new Date(window.resetsAt).toISOString() : null;
  }
}

/** Only consumes data already returned by ReClaude. No network client is
 * present: in particular this class cannot call Claude's usage/sync APIs. */
export class ReclaudeUsageMonitor {
  cacheError?: string;
  constructor(private db: DatabaseSync, private onDisabled: (accountKey: string, error: ReclaudeUsageLimitError) => void,
    private now = Date.now) {
    db.exec("CREATE TABLE IF NOT EXISTS reclaude_usage (account_key TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(account_key,kind))");
  }
  private save(accountKey: string, window: ReclaudeUsageWindow) {
    const threshold = reclaudeWindowThreshold(window.kind);
    if (threshold === null) return;
    const old = this.windows(accountKey).find(value => value.kind === window.kind);
    if (old && old.observedAt > window.observedAt) return;
    // An older/lower cached observation must not release a latched limit.
    // Only a strictly newer reset window (or confirmed fresh data after reset)
    // can start a new budget. Unknown reset times stay blocked.
    if (old && old.percent >= threshold && window.percent < threshold
      && (!old.resetsAt || this.now() < old.resetsAt || window.observedAt < old.resetsAt)) return;
    this.db.prepare("INSERT INTO reclaude_usage VALUES (?,?,?) ON CONFLICT(account_key,kind) DO UPDATE SET body=excluded.body")
      .run(accountKey, window.kind, JSON.stringify(window));
    if (window.percent >= threshold && reclaudeWindowActive(window, this.now())) {
      const blocked = this.blockedWindow(this.windows(accountKey));
      if (blocked) this.onDisabled(accountKey, new ReclaudeUsageLimitError(blocked, this.now()));
    }
  }
  observeResponse(accountKey: string, event: unknown) {
    const message = record(event), info = record(message.rate_limit_info ?? message);
    const observedAt = this.now();
    // Current Claude CLI exposes every observed header window here. The
    // top-level field can describe only the most restrictive (often 5h) one.
    const windows = { ...record(info.unifiedWindows) };
    if (typeof info.rateLimitType === "string" && (finite(info.utilization) || info.status === "rejected")) {
      windows[info.rateLimitType] = { ...record(windows[info.rateLimitType]), ...info };
    }
    for (const [kind, raw] of Object.entries(windows)) {
      const value = record(raw);
      if (reclaudeWindowThreshold(kind) === null || (!finite(value.utilization) && value.status !== "rejected")) continue;
      // A typed upstream rejection is confirmed exhaustion even when it omits
      // utilization; an untyped HTTP 429 is never guessed to be a quota window.
      const percent = value.status === "rejected" ? Math.max(100, finite(value.utilization) ? value.utilization * 100 : 100) : value.utilization * 100;
      this.save(accountKey, { kind, percent,
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
          if (reclaudeWindowThreshold(kind) === null || !finite(window.utilization)) continue;
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
  private blockedWindow(windows: ReclaudeUsageWindow[]) {
    return windows.filter(window => reclaudeWindowActive(window, this.now()) && window.percent >= (reclaudeWindowThreshold(window.kind) ?? Infinity))
      // Weekly stops take precedence over a shorter five-hour stop.
      .sort((a, b) => Number(isReclaudeWeeklyWindow(b.kind)) - Number(isReclaudeWeeklyWindow(a.kind))
        || (b.resetsAt ?? Infinity) - (a.resetsAt ?? Infinity))[0];
  }
  status(binding: ClaudeBinding): ReclaudeAccountUsage {
    const windows = this.windows(binding.accountKey);
    // A reported reset timestamp bounds that particular weekly window. After
    // it expires, mark usage unknown until a new response, never display 0%.
    const current = windows.filter(w => reclaudeWindowActive(w, this.now()));
    const blocked = this.blockedWindow(windows);
    const error = blocked ? new ReclaudeUsageLimitError(blocked, this.now()) : null;
    const known = current.some(w => isReclaudeWeeklyWindow(w.kind));
    return { orgId: binding.orgId, label: binding.label, state: blocked ? "disabled" : known ? "available" : "unknown", windows,
      message: error?.message ?? (known ? "额度随 ReClaude 已有用量数据更新。" : "尚未收到周用量数据；正常使用后自动更新。"),
      retryAfterSeconds: error?.retryAfterSeconds ?? null,
      ...(error ? { limitCode: error.code } : {}) };
  }
  assertAvailable(binding: ClaudeBinding) {
    const window = this.blockedWindow(this.windows(binding.accountKey));
    if (window) throw new ReclaudeUsageLimitError(window, this.now());
  }
}
