import { useEffect, useState } from "react";
import { readCommunicationTargets } from "./api";
import { sessionTaskLabels, type SessionTask, type SessionTaskTarget } from "../shared/sessionTasks";
import type { CommunicationOperation } from "../shared/sessionCommunication";

const terminal = new Set(["succeeded", "failed", "interrupted", "canceled", "unknown"]);
export function SessionTasks({ userId, threadId, tasks, perform, busy, visible }: {
  userId: string; threadId: string; tasks: SessionTask[]; perform: (operation: CommunicationOperation) => Promise<boolean>; busy: boolean; visible: boolean;
}) {
  const key = `communication-task-draft:${userId}:${threadId}`;
  const [draft, setDraft] = useState<{ targetThreadId: string; message: string; returnToSource: boolean }>(() => {
    try { return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? { targetThreadId: "", message: "", returnToSource: true }; }
    catch { return { targetThreadId: "", message: "", returnToSource: true }; }
  });
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<SessionTaskTarget[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* optional draft persistence */ } }, [key, draft]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void readCommunicationTargets(threadId, query, AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]))
        .then(result => { if (!controller.signal.aborted) { setTargets(result.data); setError(""); } })
        .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [threadId, visible, query]);
  return <div className="sessionTasks" aria-label="跨会话任务">
    <p>向已有会话派发任务。目标忙时排队，空闲后会实际运行模型，并沿用目标会话自己的模型、目录和权限。</p>
    <label>查找会话<input value={query} maxLength={200} placeholder="输入会话名称或编号" onChange={event => setQuery(event.target.value)} /></label>
    {error ? <p role="alert" className="communicationError">{error}</p> : null}
    <label>目标会话<select aria-label="目标会话" value={draft.targetThreadId} onChange={event => setDraft(value => ({ ...value, targetThreadId: event.target.value }))}>
      <option value="">请选择会话</option>{targets.map(target => <option key={target.threadId} value={target.threadId}>{target.name} · {target.projectName}</option>)}
    </select></label>
    <label>派发任务<textarea aria-label="派发任务" maxLength={16000} value={draft.message} onChange={event => setDraft(value => ({ ...value, message: event.target.value }))} /></label>
    <label className="sessionTaskReturn"><input type="checkbox" checked={draft.returnToSource} onChange={event => setDraft(value => ({ ...value, returnToSource: event.target.checked }))} />完成后自动回传并继续来源会话</label>
    <button type="button" className="communicationSend" disabled={busy || !draft.message.trim() || !targets.some(target => target.threadId === draft.targetThreadId)} onClick={async () => {
      if (await perform({ operation: "task.send", ...draft })) setDraft(value => ({ ...value, message: "" }));
    }}>派发并自动执行</button>
    <h3>任务记录</h3>
    {!tasks.length ? <p>暂无跨会话任务。</p> : tasks.map(task => <article className="communicationMessage" key={task.id} data-task-id={task.id}>
      <header><strong>{task.sourceThreadId === threadId ? `发送给 ${task.targetThreadName}` : `来自 ${task.sourceThreadName}`}</strong><span>{sessionTaskLabels[task.state]}</span></header>
      <pre>{task.message}</pre>
      {task.result ? <div className="communicationResult"><strong>结果</strong><pre>{task.result}</pre></div> : null}
      {task.error ? <p role="status" className="communicationError">{task.error}</p> : null}
      {task.callbackState !== "none" ? <p>结果回传：{({ queued: "等待回传", dispatching: "正在回传", delivered: "已交回来源会话", failed: "回传失败，结果仍保存在此处", unknown: "接收状态待核对，结果仍保存在此处" })[task.callbackState]}</p> : null}
      {task.callbackError ? <p className="communicationError">{task.callbackError}</p> : null}
      {task.cancelRequested && !terminal.has(task.state) ? <p>已请求取消，正在核对并停止本任务对应的轮次。</p> : null}
      {!terminal.has(task.state) ? <button type="button" disabled={busy || task.cancelRequested} onClick={() => void perform({ operation: "task.cancel", id: task.id })}>取消任务</button> : null}
      {task.targetHref ? <p><a href={task.targetHref} target="_blank" rel="noopener noreferrer">在新标签页查看目标会话</a></p> : null}
      <details><summary>任务编号</summary><code>{task.id}</code>{task.targetTurnId ? <p>执行轮次：{task.targetTurnId}</p> : null}</details>
    </article>)}
  </div>;
}
