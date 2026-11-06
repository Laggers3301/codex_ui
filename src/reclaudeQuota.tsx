import { isReclaudeWeeklyWindow, reclaudeWindowActive, type ReclaudeAccountUsage, type ReclaudeUsageWindow } from "../shared/reclaudeUsage";
import { remainingTime, type ReclaudeQuota } from "../shared/reclaudeUsage";

const percent = (value: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
const remaining = (window: ReclaudeUsageWindow) => percent(Math.max(0, 100 - window.percent));
const dateTime = (timestamp: number) => new Date(timestamp).toLocaleString("zh-CN", { hour12: false });

export function reclaudeRemainingLabel(account: ReclaudeAccountUsage, now = Date.now()): string {
  if (account.state === "disabled") return account.limitCode === "claude_five_hour_limit" ? "5h 已满" : "已停用";
  const active = account.windows.filter(window => reclaudeWindowActive(window, now));
  const fiveHour = active.find(window => window.kind === "five_hour");
  const weekly = active.filter(window => isReclaudeWeeklyWindow(window.kind));
  if (fiveHour && !weekly.length) return `5h ${remaining(fiveHour)}%`;
  if (!active.length) return "--";
  return `${percent(Math.max(0, Math.min(...active.map(window => 100 - window.percent))))}%`;
}

function windowLabel(kind: string): string {
  if (kind === "five_hour") return "5 小时";
  if (kind === "seven_day") return "周限";
  if (kind.includes("sonnet")) return "Sonnet 周限";
  if (kind.includes("opus")) return "Opus 周限";
  return "模型周限";
}

export function ReclaudeQuotaDetails({ account, cacheError, creations, now = Date.now() }: { account: ReclaudeAccountUsage; cacheError?: string; creations?: ReclaudeQuota; now?: number }) {
  const kinds = ["five_hour", "seven_day", ...account.windows.filter(window => isReclaudeWeeklyWindow(window.kind) && window.kind !== "seven_day").map(window => window.kind)];
  const observedAt = Math.max(0, ...account.windows.map(window => window.observedAt));
  return <div className="providerQuotaDetails reclaudeQuotaDetails" role="tabpanel" aria-label="ReClaude 额度">
    {account.state === "disabled" ? <p className="providerQuotaRestriction" role="status">{account.limitCode === "claude_five_hour_limit" ? "5 小时额度已达上限 · 账号已暂停" : "周用量达到 99% 停用阈值 · 账号已停用"}</p> : null}
    <div className="quotaPopoverRows">
      {kinds.map(kind => {
        const window = account.windows.find(window => window.kind === kind);
        const active = window && reclaudeWindowActive(window, now);
        return <div key={kind} data-quota-window={kind}>
          <span>{windowLabel(kind)}</span>
          <strong>{!window ? "待更新" : !active ? "已到重置时间，待更新" : <>
            <span className="providerQuotaBalance">剩余 {remaining(window)}%<span>已用 {percent(window.percent)}%</span></span>
            {window.resetsAt ? <span className="providerQuotaReset">重置 {dateTime(window.resetsAt)}</span> : null}
          </>}</strong>
        </div>;
      })}
      {creations ? <div data-quota-window="creations"><span title="全部 Claude 账号共用；仅新建、分支和迁入 Claude 计数，不影响已有会话继续回答。">新建</span><strong>本小时剩余 {creations.remaining}/{creations.limit} 次{creations.remaining === 0 ? <span className="providerQuotaReset">{remainingTime(creations.retryAfterSeconds)}后可重试</span> : null}</strong></div> : null}
      <div className="providerQuotaUpdated"><span>数据时间</span><strong>{observedAt ? dateTime(observedAt) : "待更新"}</strong></div>
    </div>
    {account.state === "disabled" ? <p>{account.message}</p> : null}
    {cacheError ? <p>{cacheError}</p> : null}
  </div>;
}
