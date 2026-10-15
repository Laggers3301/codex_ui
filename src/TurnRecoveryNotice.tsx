import { useEffect, useState } from "react";
import { AccountUpdateIndicator } from "./AccountUpdateIndicator";
import "./TurnRecoveryNotice.css";

export interface TurnRecoveryView {
  threadId: string;
  error: null | { code: string; message: string; originalMessage: string; retryable: boolean; at: string };
  job: null | { status: "waiting" | "running" | "exhausted"; attempts: number; maxAttempts: number; nextRetryAt: number | null };
}

export function historicalRecovery(threadId: string, turn?: { status: unknown; [key: string]: unknown }): TurnRecoveryView | undefined {
  if (turn?.status !== "failed" || !turn.error || typeof turn.error !== "object") return;
  const error = turn.error as Record<string, unknown>;
  if (typeof error.message !== "string") return;
  return { threadId, job: null, error: { code: typeof error.code === "string" ? error.code : String(error.codexErrorInfo ?? "request_failed"),
    message: error.message, originalMessage: typeof error.originalMessage === "string" ? error.originalMessage : error.message,
    retryable: false, at: typeof error.at === "string" ? error.at : "" } };
}

export function TurnRecoveryNotice({ state, userId, onAction }: { state?: TurnRecoveryView; userId: string; onAction: (action: "now" | "cancel" | "dismiss") => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (state?.job?.status !== "waiting") return;
    setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [state?.job?.status, state?.job?.nextRetryAt]);
  if (!state?.error && !state?.job) return null;
  const job = state.job;
  return <div className="turnRecoveryNotice" role="status">
    <div><strong>{state.error?.message ?? "正在继续原任务。"}</strong><AccountUpdateIndicator userId={userId} menuOpen={false} target="runtime" dismissOnRefresh /></div>
    {job?.status === "waiting" ? <p>已排队，约 {Math.max(0, Math.ceil(((job.nextRetryAt ?? now) - now) / 1000))} 秒后进行第 {job.attempts + 1} 次重试（最多 {job.maxAttempts} 次）。</p> : null}
    {job?.status === "running" ? <p>正在进行第 {job.attempts} 次自动续接，沿用当前会话和模型。</p> : null}
    {job?.status === "exhausted" ? <p>已达到 {job.maxAttempts} 次重试上限，请稍后继续或调整模型。</p> : null}
    {state.error ? <details><summary>错误详情 · {state.error.code}</summary><pre>{state.error.originalMessage}</pre></details> : null}
    <div className="turnRecoveryActions">
      {job?.status === "waiting" ? <><button type="button" onClick={() => onAction("now")}>立即重试</button><button type="button" onClick={() => onAction("cancel")}>取消自动重试</button></> : null}
      {!job || job.status === "exhausted" ? <button type="button" onClick={() => onAction("dismiss")}>关闭提示</button> : null}
    </div>
  </div>;
}
