import { useEffect, useRef, useState } from "react";
import { readCommunication, sendCommunication } from "./api";
import { communicationStateLabels, type CommunicationCommand, type CommunicationKind, type CommunicationMessage, type CommunicationOperation, type CommunicationSnapshot } from "../shared/sessionCommunication";
import "./sessionCommunication.css";

const labels = { topic: "Topic 话题", service: "Service 服务", action: "Action 任务" };
const descriptions = { topic: "订阅同名话题的会话会收到广播，可用于同步状态和共享消息。", service: "注册提供会话后，通过名称发起请求，由提供会话返回一次结果。", action: "提交长任务目标，提供会话接收后可反馈进度、返回结果并确认取消。" };
const ended = new Set(["succeeded", "failed", "rejected", "canceled", "timed_out"]);
const normalizedName = (value: string) => "/" + value.trim().replace(/^\/+|\/+$/g, "");
function stored<T>(key: string, fallback: T): T { try { return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? fallback; } catch { return fallback; } }
function save(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* A full browser store must not block reading the inbox. */ } }

export function SessionCommunication({ userId, threadId, threadName, visible }: { userId: string; threadId?: string; threadName?: string; visible: boolean }) {
  const scope = `${userId}:${threadId ?? ""}`;
  const draftKey = `communication-draft:${scope}`;
  const [mode, setMode] = useState<CommunicationKind>("topic");
  const [draft, setDraft] = useState(() => stored(draftKey, { name: "/updates", message: "", timeout: 120 }));
  const [data, setData] = useState<CommunicationSnapshot | null>(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>(() => stored(`communication-answers:${scope}`, {}));
  const [progress, setProgress] = useState<Record<string, string>>(() => stored(`communication-progress:${scope}`, {}));
  const refreshRef = useRef<() => void>(() => {});
  const requests = useRef(stored<Record<string, string>>(`communication-retries:${scope}`, {}));
  const pendingMutation = useRef(false);
  useEffect(() => save(draftKey, draft), [draftKey, draft]);
  useEffect(() => save(`communication-answers:${scope}`, answers), [scope, answers]);
  useEffect(() => save(`communication-progress:${scope}`, progress), [scope, progress]);
  useEffect(() => {
    if (!visible || !threadId) return;
    let active = true, timer = 0, controller: AbortController | null = null, again = false;
    const refresh = async () => {
      if (!active || document.hidden) return;
      if (controller) { again = true; return; }
      window.clearTimeout(timer); controller = new AbortController(); const request = controller;
      try { const result = await readCommunication(threadId, AbortSignal.any([request.signal, AbortSignal.timeout(8000)])); if (active) { setData(result.data); setReadError(""); } }
      catch (caught) { if (active && !request.signal.aborted) setReadError(caught instanceof Error ? caught.message : String(caught)); }
      finally { if (active) { controller = null; timer = window.setTimeout(() => void refresh(), again ? 0 : 5000); again = false; } }
    };
    refreshRef.current = () => void refresh();
    const event = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail?.threadIds?.includes(threadId)) void refresh(); };
    const visibility = () => { window.clearTimeout(timer); if (!document.hidden) void refresh(); };
    window.addEventListener("codex:communication", event); document.addEventListener("visibilitychange", visibility); void refresh();
    return () => { active = false; controller?.abort(); window.clearTimeout(timer); window.removeEventListener("codex:communication", event); document.removeEventListener("visibilitychange", visibility); };
  }, [scope, visible, threadId]);
  async function perform(input: CommunicationOperation): Promise<boolean> {
    if (!threadId || pendingMutation.current) return false;
    const operation = "name" in input ? { ...input, name: normalizedName(input.name) } : input;
    const key = JSON.stringify(operation);
    const requestId = requests.current[key] ?? globalThis.crypto?.randomUUID?.() ?? `communication-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    requests.current[key] = requestId; save(`communication-retries:${scope}`, requests.current);
    pendingMutation.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await sendCommunication(threadId, { ...operation, requestId } as CommunicationCommand);
      delete requests.current[key]; save(`communication-retries:${scope}`, requests.current);
      setNotice(operation.operation === "topic.publish" ? `已发布，投递给 ${result.data.delivered ?? 0} 个订阅会话。`
        : operation.operation === "service.call" ? "请求已投递。"
          : operation.operation === "action.send" ? "目标已投递。"
            : operation.operation === "action.cancel" ? result.data.state === "canceled" ? "尚未接收的目标已取消。" : "取消请求已发送。" : "操作已保存。");
      refreshRef.current(); return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return false; }
    finally { pendingMutation.current = false; setBusy(false); }
  }
  const binding = data?.bindings.some(binding => binding.kind === mode && binding.name === normalizedName(draft.name));
  const registration = mode === "topic" ? binding ? "topic.unsubscribe" : "topic.subscribe" : mode === "service" ? binding ? "service.unadvertise" : "service.advertise" : binding ? "action.unadvertise" : "action.advertise";
  const registrationLabel = mode === "topic" ? binding ? "取消订阅" : "订阅话题" : binding ? "注销提供者" : mode === "service" ? "注册服务提供者" : "注册任务提供者";
  const send = async () => {
    const input = { name: draft.name, message: draft.message };
    const operation: CommunicationOperation = mode === "topic" ? { ...input, operation: "topic.publish" }
      : mode === "service" ? { ...input, operation: "service.call", timeoutSeconds: draft.timeout }
        : { ...input, operation: "action.send", timeoutSeconds: draft.timeout };
    if (await perform(operation)) setDraft(current => ({ ...current, message: "" }));
  };
  function renderMessage(message: CommunicationMessage, inbox: boolean) {
    const isProvider = inbox && message.targetThreadId === threadId, terminal = ended.has(message.state);
    return <article className="communicationMessage" key={message.id} data-message-id={message.id}>
      <header><strong>{message.name}</strong><span className="communicationState">{communicationStateLabels[message.state]}</span></header>
      <p>{inbox ? `来自 ${message.sourceThreadName}` : message.targetThreadName ? `发送给 ${message.targetThreadName}` : "话题广播"} · {new Date(message.createdAt).toLocaleTimeString()}</p>
      <pre>{message.message}</pre>
      {message.deadlineAt && message.state === "pending" ? <p>{message.kind === "action" ? "接收期限" : "答复期限"}：{new Date(message.deadlineAt).toLocaleTimeString()}</p> : null}
      {message.progress != null ? <div className="communicationProgress"><progress max={100} value={message.progress} aria-label="任务进度" /><span>{message.progress}%</span></div> : null}
      {message.feedback.length ? <details><summary>进度反馈（{message.feedback.length}）</summary>{message.feedback.map((feedback, index) => <p key={`${feedback.at}:${index}`}><time>{new Date(feedback.at).toLocaleTimeString()}</time> {feedback.message}{feedback.progress != null ? ` · ${feedback.progress}%` : ""}</p>)}</details> : null}
      {message.result ? <div className="communicationResult"><strong>结果</strong><pre>{message.result}</pre></div> : null}
      {message.state === "timed_out" ? <p>期限内未收到{message.kind === "action" ? "接收确认" : "答复"}，请求已结束。</p> : null}
      {inbox && message.unread && message.kind === "topic" ? <button type="button" disabled={busy} onClick={() => void perform({ operation: "inbox.ack", id: message.id })}>标记已读</button> : null}
      {isProvider && !terminal ? <div className="communicationReply">
        {message.kind === "action" && message.state === "pending" ? <><button type="button" disabled={busy} onClick={() => void perform({ operation: "action.update", id: message.id, status: "accepted" })}>接收任务</button><textarea aria-label={`拒绝原因 ${message.id}`} placeholder="如需拒绝，填写原因" value={answers[message.id] ?? ""} onChange={event => setAnswers(current => ({ ...current, [message.id]: event.target.value }))} maxLength={4000} /><button type="button" disabled={busy || !answers[message.id]?.trim()} onClick={() => void perform({ operation: "action.update", id: message.id, status: "rejected", message: answers[message.id] })}>拒绝任务</button></> : <>
          <textarea aria-label={`${message.kind === "service" ? "服务回复" : "任务反馈"} ${message.id}`} value={answers[message.id] ?? ""} maxLength={message.kind === "service" ? 16000 : 4000} onChange={event => setAnswers(current => ({ ...current, [message.id]: event.target.value }))} placeholder={message.kind === "service" ? "填写回复内容" : "填写进度、结果或取消原因"} />
          {message.kind === "action" ? <label>进度 %<input type="number" min={0} max={100} aria-label={`任务进度 ${message.id}`} value={progress[message.id] ?? ""} onChange={event => setProgress(current => ({ ...current, [message.id]: event.target.value }))} /></label> : null}
          <div className="communicationActions">
            {message.kind === "service" ? <><button type="button" disabled={busy || !answers[message.id]?.trim()} onClick={() => void perform({ operation: "service.respond", id: message.id, result: answers[message.id], success: true })}>返回结果</button><button type="button" disabled={busy || !answers[message.id]?.trim()} onClick={() => void perform({ operation: "service.respond", id: message.id, result: answers[message.id], success: false })}>返回错误</button></> : <>
              <button type="button" disabled={busy || (!answers[message.id]?.trim() && progress[message.id] === undefined)} onClick={() => void perform({ operation: "action.update", id: message.id, status: "executing", message: answers[message.id] ?? "", ...(progress[message.id]?.trim() ? { progress: Number(progress[message.id]) } : {}) })}>反馈进度</button>
              <button type="button" disabled={busy || !answers[message.id]?.trim()} onClick={() => void perform({ operation: "action.update", id: message.id, status: "succeeded", message: answers[message.id] })}>完成任务</button>
              <button type="button" disabled={busy || !answers[message.id]?.trim()} onClick={() => void perform({ operation: "action.update", id: message.id, status: "failed", message: answers[message.id] })}>报告失败</button>
              {message.state === "cancel_requested" ? <button type="button" disabled={busy || !answers[message.id]?.trim()} onClick={() => void perform({ operation: "action.update", id: message.id, status: "canceled", message: answers[message.id] })}>确认已取消</button> : null}
            </>}
          </div>
        </>}
      </div> : null}
      {!inbox && message.kind === "action" && !terminal && message.state !== "cancel_requested" ? <button type="button" disabled={busy} onClick={() => void perform({ operation: "action.cancel", id: message.id })}>请求取消</button> : null}
      <details className="communicationIdentifier"><summary>消息编号</summary><code>{message.id}</code></details>
    </article>;
  }
  return <section className="communicationPanel" aria-label="会话通信">
    <header><h2>会话通信</h2><button type="button" onClick={() => refreshRef.current()} disabled={!threadId}>刷新</button></header>
    {!threadId ? <p>请先打开一个会话，再订阅话题或注册服务。</p> : <>
      <p>当前会话：{threadName || threadId}</p><p>模型可使用 session_communication 工具读取收件箱和回复。空闲会话的消息会保留到下次运行读取。</p>
      <div role="tablist" aria-label="通信方式">{(["topic", "service", "action"] as const).map(kind => <button role="tab" aria-selected={mode === kind} key={kind} type="button" onClick={() => { setMode(kind); setNotice(""); }}>{labels[kind]}</button>)}</div>
      <div role="tabpanel" aria-label={labels[mode]}><p>{descriptions[mode]}</p>
        <label>{mode === "topic" ? "话题名称" : mode === "service" ? "服务名称" : "任务名称"}<input value={draft.name} maxLength={120} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label>
        <button type="button" disabled={busy || !draft.name.trim() || !data} onClick={() => void perform({ operation: registration, name: draft.name })}>{registrationLabel}</button>
        <div className="communicationDirectory" aria-label="已注册通信端点">{data?.directory.filter(binding => binding.kind === mode).map(binding => <button type="button" key={`${binding.name}:${binding.threadId}`} onClick={() => setDraft(current => ({ ...current, name: binding.name }))}>{binding.name} · {binding.threadName}</button>)}</div>
        <label>{mode === "topic" ? "广播内容" : mode === "service" ? "请求内容" : "任务目标"}<textarea value={draft.message} maxLength={16000} onChange={event => setDraft(current => ({ ...current, message: event.target.value }))} /></label>
        {mode !== "topic" ? <label>{mode === "service" ? "答复期限（秒）" : "接收期限（秒）"}<input type="number" min={1} max={3600} value={draft.timeout} onChange={event => setDraft(current => ({ ...current, timeout: Number(event.target.value) }))} /></label> : null}
        <button className="communicationSend" type="button" disabled={busy || !draft.name.trim() || !draft.message.trim() || !data} onClick={() => void send()}>{mode === "topic" ? "发布消息" : mode === "service" ? "发起请求" : "提交目标"}</button>
      </div>
      {readError ? <p role="status" className="communicationError">读取失败，保留上次记录：{readError}</p> : null}{error ? <p role="alert" className="communicationError">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
      <h3>收件箱{data ? ` · ${data.unreadCount} 未读` : ""}</h3>{data?.inbox.filter(message => message.kind === mode).map(message => renderMessage(message, true))}
      {!data?.inbox.some(message => message.kind === mode) ? <p>{data ? "暂无此类消息。" : "正在读取…"}</p> : null}
      <h3>发件记录</h3>{data?.outbox.filter(message => message.kind === mode).map(message => renderMessage(message, false))}
      {!data?.outbox.some(message => message.kind === mode) ? <p>暂无此类记录。</p> : null}
      <p>展示近期通信记录，单条消息最多 16,000 字符，任务保留最近 50 条进度反馈。</p>
    </>}
  </section>;
}
