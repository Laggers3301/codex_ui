import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { memberRealName } from "../shared/memberDirectory";
import type { CodexLeaderboard, CodexLeaderboardUserUsage } from "./types";

export function leaderboardPersonName(user: Pick<CodexLeaderboardUserUsage, "userId" | "displayName">): string {
  return memberRealName(user.userId) ?? user.displayName ?? `待核实（${user.userId}）`;
}

export function leaderboardPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)}%` : "—";
}

type LeaderboardPeriod = "currentCycle" | "lifetime";

function LeaderboardPeriodPanel({ leaderboard, boardPeriod }: { leaderboard: CodexLeaderboard; boardPeriod: LeaderboardPeriod }) {
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [period, setPeriod] = useState<LeaderboardPeriod>(boardPeriod);
  const selected = selectedUserId
    ? leaderboard[period].users.find(user => user.userId === selectedUserId) : null;
  const sourceUser = leaderboard[boardPeriod].users.find(user => user.userId === selectedUserId);
  const title = boardPeriod === "currentCycle" ? "当前周期" : "总榜";
  const rankedUsers = [...leaderboard[boardPeriod].users].sort((a, b) =>
    (b.poolQuotaPercent ?? -1) - (a.poolQuotaPercent ?? -1) || b.totalTokens - a.totalTokens);

  if (selectedUserId && (selected || sourceUser)) {
    const person = selected ?? sourceUser!;
    return <section className="leaderboardScope leaderboardPeriodPanel leaderboardPersonDetails" data-leaderboard-period={boardPeriod} aria-label={`${title} · ${leaderboardPersonName(person)}使用明细`}>
      <header className="leaderboardScopeHeader">
        <button type="button" className="leaderboardBack" onClick={() => { setSelectedUserId(null); setPeriod(boardPeriod); }}>
          <ChevronLeft size={16} /> 返回排行
        </button>
        <div><h3>{leaderboardPersonName(person)}</h3><p>{period === "currentCycle" ? "本周期" : "历史累计"}占总号池 {leaderboardPercent(selected?.poolQuotaPercent)}</p></div>
      </header>
      <div className="leaderboardPeriodTabs" aria-label="使用明细周期">
        <button type="button" aria-pressed={period === "currentCycle"} onClick={() => setPeriod("currentCycle")}>当前周期</button>
        <button type="button" aria-pressed={period === "lifetime"} onClick={() => setPeriod("lifetime")}>历史累计</button>
      </div>
      <div className="leaderboardModelDetails">
        {(selected?.models ?? []).map(model => <article className="leaderboardModelDetail" key={`${model.model}:${model.effort ?? ""}`}>
          <div><strong>{model.model}</strong>{model.effort ? <small>{model.effort}</small> : null}</div>
          <span>{leaderboardPercent(model.poolQuotaPercent)}</span>
          <p>{new Intl.NumberFormat("zh-CN").format(model.totalTokens)} Token · {model.sessionCount} 个会话</p>
        </article>)}
        {!selected?.models.length ? <div className="emptyState">该周期暂无模型用量。</div> : null}
      </div>
      <p className="leaderboardQuotaNote">{period === "currentCycle"
        ? "模型百分比为占总 GPT 号池的估算额度；独立 API 套餐或未核实额度显示 —。"
        : "历史 Token 按同账号当前周期的 Token/额度比例折算；缺少账号样本时用号池整体比例估算。累计可超过 100%，独立 API 套餐不计入。"}</p>
    </section>;
  }

  return <section className="leaderboardScope leaderboardPeriodPanel leaderboardPeople" data-leaderboard-period={boardPeriod} aria-label={`${title}额度排行榜`}>
    <header className="leaderboardScopeHeader">
      <div><h3>{title}</h3><p>姓名 · 占总号池额度</p></div>
    </header>
    {rankedUsers.length ? <div className="leaderboardPeopleRows">
      {rankedUsers.map(user => <button type="button" className="leaderboardPersonRow" key={user.userId}
        aria-label={`查看${leaderboardPersonName(user)}的模型及额度明细`}
        onClick={() => { setSelectedUserId(user.userId); setPeriod(boardPeriod); }}>
        <strong>{leaderboardPersonName(user)}</strong>
        <span>{leaderboardPercent(user.poolQuotaPercent)}<ChevronRight size={15} aria-hidden="true" /></span>
      </button>)}
    </div> : <div className="emptyState">{title}暂无用量记录。</div>}
    {boardPeriod === "lifetime" ? <p className="leaderboardQuotaNote">历史 Token 折算为累计估算额度，可超过 100%；缺少校准依据显示 —。</p> : null}
  </section>;
}

export function LeaderboardPanel({ leaderboard }: { leaderboard: CodexLeaderboard }) {
  return <div className="leaderboardPanels">
    <LeaderboardPeriodPanel leaderboard={leaderboard} boardPeriod="currentCycle" />
    <LeaderboardPeriodPanel leaderboard={leaderboard} boardPeriod="lifetime" />
  </div>;
}
