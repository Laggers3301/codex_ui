import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "./PanelIcons";
import "./TurnRecoveryNotice.css";
import { modelErrorDetails } from "../shared/modelError";
import { errorSource, type ErrorSource, type TurnRecoveryView } from "../shared/turnRecovery";
export type { TurnRecoveryView } from "../shared/turnRecovery";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

export function historicalRecovery(threadId: string, turn?: { status: unknown; [key: string]: unknown }): TurnRecoveryView | undefined {
  if (!turn || (turn.status !== "failed" && turn.status !== "interrupted")) return;
  const nativeError = turn.error && typeof turn.error === "object" ? turn.error : undefined;
  const detail = modelErrorDetails(nativeError);
  const code = nativeError ? detail.code : turn.status === "interrupted" ? "turn_interrupted" : "request_failed";
  const message = nativeError ? detail.message : turn.status === "interrupted" ? "本轮已中断，中断来源尚未确认。" : "本轮处理失败，运行时未提供具体错误原因。";
  const source = errorSource(code), completedAt = turn.completedAt;
  const at = typeof record(nativeError).at === "string" ? String(record(nativeError).at)
    : typeof completedAt === "number" && Number.isFinite(completedAt) ? new Date(completedAt * (completedAt < 1e12 ? 1000 : 1)).toISOString() : "";
  const unresolvedTools = (Array.isArray(turn.items) ? turn.items : []).filter(item => {
    const value = record(item);
    return /tool|commandExecution|fileChange/i.test(String(value.type)) && (value.completed === false || ["inProgress", "running", "pending"].includes(String(value.status)));
  }).map(item => String(record(item).id ?? "未确认的工具"));
  return { threadId, job: null, error: { code, message, originalMessage: nativeError ? detail.message : "历史记录未保留具体原因，请核对上一轮的实际执行结果。", retryable: false, at, source },
    ...(typeof turn.id === "string" ? { interruption: { turnId: turn.id, source, unresolvedTools } } : {}) };
}

export const hasRecoveryNotice = (state?: TurnRecoveryView) => Boolean(state?.error || state?.job);
export function recoverySourceLabel(source?: ErrorSource): string {
  return ({ user: "主动停止", runtime: "运行进程退出", backend: "服务重新启动", connection: "模型连接中断", provider: "模型服务错误", resource: "运行资源不足", unknown: "来源未确认" })[source ?? "unknown"];
}

export function recoveryViewportBounds(width: number, height: number, viewport?: { offsetLeft: number; offsetTop: number; width: number; height: number }) {
  return { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? width, height: viewport?.height ?? height };
}

export type RecoveryAction = "now" | "cancel" | "dismiss" | "check" | "continue";
export function TurnRecoveryNotice({ state, userId, turnId, onSelectModel, onCopy, onAction }: {
  state?: TurnRecoveryView; userId: string; turnId?: string; onSelectModel?: () => void;
  onCopy?: (text: string) => Promise<void>; onAction: (action: RecoveryAction, toolsReviewed?: boolean) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [dismissedKey, setDismissedKey] = useState<string | null>(null), [toolsReviewed, setToolsReviewed] = useState(false);
  const [copied, setCopied] = useState("");
  const key = `codex-recovery-seen:${userId}:${state?.threadId ?? ""}:${state?.interruption?.turnId ?? turnId ?? ""}:${state?.error?.at ?? ""}:${state?.error?.code ?? ""}`;
  const close = () => { try { sessionStorage.setItem(key, "1"); } catch {} setDismissedKey(key); };
  useEffect(() => {
    setCopied(""); setToolsReviewed(false);
  }, [key]);
  useEffect(() => { setToolsReviewed(false); }, [state?.interruption?.inspection?.at]);
  useEffect(() => {
    if (state?.job?.status !== "waiting") return;
    setNow(Date.now()); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [state?.job?.status, state?.job?.nextRetryAt]);
  let seen = false; try { seen = sessionStorage.getItem(key) === "1"; } catch {}
  if (!state || !hasRecoveryNotice(state) || dismissedKey === key || seen) return null;
  const view = state, job = view.job, inspection = view.interruption?.inspection;
  const target = document.querySelector(".threadNoticeStack");
  if (!target) return null;
  const canInspect = Boolean(view.interruption && (!job || job.status === "exhausted"));
  const canContinue = inspection?.status === "ready" || (inspection?.status === "needs_review" && toolsReviewed);
  const source = recoverySourceLabel(view.error?.source ?? view.interruption?.source);
  const timestamp = view.error?.at && Number.isFinite(Date.parse(view.error.at)) ? new Date(view.error.at).toLocaleString("zh-CN", { hour12: false }) : "发生时间未记录";
  return createPortal(<div className="errorBanner providerErrorBanner turnRecoveryBanner" role="alert" aria-label="本轮模型状态">
    <div className="errorBannerMessage">
      <span>{job?.status === "running" ? "正在重试本轮请求。" : view.error?.code === "model_overloaded" ? "模型繁忙，可切换模型或稍后重试。" : view.error?.message ?? "正在继续原任务。"}</span>
      {job?.status === "waiting" ? <span> 等待重试 · {Math.max(0, Math.ceil(((job.nextRetryAt ?? now) - now) / 1000))} 秒 · 第 {job.attempts + 1}/{job.maxAttempts} 次</span> : null}
      {job?.status === "running" ? <span> 第 {job.attempts} 次自动续接，沿用当前会话和模型。</span> : null}
      {job?.status === "exhausted" ? <span> 已达到 {job.maxAttempts} 次重试上限，请稍后继续或调整模型。</span> : null}
      {view.error ? <>
        <div className="turnRecoveryMeta"><span>{source}</span><time dateTime={view.error.at || undefined}>{timestamp}</time></div>
        <details><summary>错误详情 · {view.error.code}</summary><pre>{view.error.originalMessage}</pre>
          {view.interruption?.unresolvedTools.length ? <p>未确认结果的工具：{view.interruption.unresolvedTools.join("、")}</p> : null}
        </details>
      </> : null}
      {inspection ? <p className="turnRecoveryInspection" role="status">{inspection.message}</p> : null}
      {canInspect && inspection?.status === "needs_review" ? <label className="turnRecoveryReview"><input type="checkbox" checked={toolsReviewed} onChange={event => setToolsReviewed(event.target.checked)} /><span>我已核对上一轮和未结束工具的实际执行结果</span></label> : null}
    </div>
    <div className="turnRecoveryActions">
      {canInspect ? <><button type="button" disabled={inspection?.status === "checking"} onClick={() => onAction("check")}>核对运行状态</button>
        <button type="button" disabled={!canContinue} onClick={() => onAction("continue", toolsReviewed)}>沿用任务继续</button></> : null}
      {job?.status === "waiting" ? <><button type="button" onClick={() => onAction("now")}>立即重试</button><button type="button" onClick={() => onAction("cancel")}>取消自动重试</button></> : null}
      {view.error && onCopy ? <button type="button" onClick={() => { void onCopy([view.error!.message, `${source} · ${timestamp}`, view.error!.code, view.error!.originalMessage, inspection?.message].filter(Boolean).join("\n")).then(() => setCopied("已复制"), () => setCopied("复制失败，请选中详情复制")); }}>{copied || "复制错误详情"}</button> : null}
      {job?.status !== "running" && onSelectModel ? <button type="button" onClick={onSelectModel}>切换模型</button> : null}
    </div>
    <button className="iconButton errorBannerDismiss" type="button" aria-label="关闭模型状态提示" onClick={() => { close(); if (!job || job.status === "exhausted") onAction("dismiss"); }}><X size={16} /></button>
  </div>, target);
}
