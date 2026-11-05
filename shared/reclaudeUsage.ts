export interface ReclaudeUsageWindow {
  kind: string;
  percent: number;
  resetsAt: number | null;
  observedAt: number;
  source: "response" | "reclaude-cache";
}
export type ReclaudeLimitCode = "claude_five_hour_limit" | "claude_weekly_limit";

export function isReclaudeWeeklyWindow(kind: string): boolean {
  return kind === "seven_day" || kind.startsWith("seven_day_") || kind === "model_weekly";
}

export function reclaudeWindowThreshold(kind: string): number | null {
  return isReclaudeWeeklyWindow(kind) ? 99 : kind === "five_hour" ? 100 : null;
}

export function reclaudeWindowActive(window: ReclaudeUsageWindow, now = Date.now()): boolean {
  return window.resetsAt === null || window.resetsAt > now;
}

export interface ReclaudeAccountUsage {
  orgId: string;
  label: string;
  state: "unknown" | "available" | "disabled";
  windows: ReclaudeUsageWindow[];
  message: string;
  retryAfterSeconds: number | null;
  limitCode?: ReclaudeLimitCode;
}
export interface ReclaudeQuota {
  limit: number; windowSeconds: number; used: number; remaining: number;
  retryAt: string | null; retryAfterSeconds: number;
}
export interface ReclaudeUsageStatus {
  thresholdPercent: number;
  accounts: ReclaudeAccountUsage[];
  creations: ReclaudeQuota;
  monitoring: "response-events" | "response-events-and-cache";
  cacheError?: string;
}
export function remainingTime(seconds: number): string {
  const n = Math.max(0, Math.ceil(seconds));
  if (n < 60) return `${n} 秒`;
  if (n < 3600) return `${Math.floor(n / 60)} 分 ${n % 60} 秒`;
  if (n < 86400) return `${Math.floor(n / 3600)} 小时 ${Math.ceil(n % 3600 / 60)} 分`;
  return `${Math.floor(n / 86400)} 天 ${Math.ceil(n % 86400 / 3600)} 小时`;
}
