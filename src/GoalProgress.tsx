import { useRef, useState } from "react";
import { Target, Pause, Play, Close, Refresh } from "@icon-park/svg";
import { ToolReveal } from "./ToolReveal";
import { useThreadGoal } from "./threadGoal";
import "./threadActivity.css";
type Props = { controller: ReturnType<typeof useThreadGoal>; running: boolean };
const labels: Record<string, string> = { active: "等待继续", paused: "已暂停", complete: "已完成", blocked: "等待处理", usageLimited: "额度受限", budgetLimited: "达到预算" };
export function GoalProgress({ controller, running }: Props) {
  const [expanded, setExpanded] = useState(false);
  const present = Boolean(controller.goal || controller.pending || controller.error);
  const retained = useRef(controller);
  if (present) retained.current = controller;
  const { goal, pending, error } = present ? controller : retained.current;
  const icon = (fn: typeof Target) => <span className="threadActivityIcon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: fn({ size: 16, theme: "outline", fill: "currentColor", strokeWidth: 3 }).replace(/^<\?xml[^>]*>/, "") }} />;
  return <ToolReveal open={present}><section className="threadActivityStrip goalProgress" aria-label="当前会话持续目标">
    <div className="goalProgressRow">
      <button className="threadActivityHeading" type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
        {icon(Target)}<span className="goalProgressStatus">{pending ? "正在确认…" : `持续目标 · ${goal?.status === "active" && running ? "执行中" : labels[goal?.status ?? ""] ?? "未启动"}`}</span>
        <span className="goalObjective" title={goal?.objective}>{goal?.objective}</span>
      </button>
      {goal ? <button type="button" disabled={pending || ["complete", "usageLimited", "budgetLimited"].includes(goal.status)} title={goal.status === "active" && !error ? "暂停目标" : "继续目标"} aria-label={goal.status === "active" && !error ? "暂停目标" : "继续目标"} onClick={goal.status === "active" && !error ? controller.pause : controller.resume}>{icon(goal.status === "active" && !error ? Pause : Play)}</button> : null}
      <button type="button" disabled={pending} aria-label="刷新目标状态" onClick={controller.refresh}>{icon(Refresh)}</button>
      {goal ? <button type="button" disabled={pending} aria-label="结束并清除目标" onClick={controller.clear}>{icon(Close)}</button> : null}
    </div>
    <ToolReveal open={expanded || Boolean(error)}><div className="goalProgressDetails">{error ? <p role="alert">{error}</p> : <><p>{goal?.objective}</p>{goal?.tokensUsed ? <small>已使用 {goal.tokensUsed.toLocaleString()} token{goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ""}</small> : null}</>}</div></ToolReveal>
  </section></ToolReveal>;
}
