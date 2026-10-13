import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, RefreshCcw as RefreshCw, Link as ExternalLink } from "./PanelIcons";
import "./FeishuOffice.css";

type Status = { configured: boolean; connected: boolean; identity?: string; scopes: string; requestedScopes?: string; needsAuthorization?: boolean; needsAdditionalAuthorization?: boolean; capabilities?: string[]; pendingVerificationCapabilities?: string[]; unavailable: { name: string; reason: string }[] };
type Proposal = { id: string; operation: string; args: Record<string, unknown>; summary: string; threadId: string; status: string; actor?: string };
async function request<T>(url: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/feishu/${url}`, { method, credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "飞书连接失败"); return data;
}
function contentPreview(args: Record<string, unknown>): string {
  const strings: string[] = [];
  const visit = (v: unknown, key = "", depth = 0) => {
    if (depth > 12) return;
    if (typeof v === "string" && ["text", "title", "name", "summary", "description", "content"].includes(key)) strings.push(v);
    else if (Array.isArray(v)) v.forEach(x => visit(x, key, depth + 1));
    else if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => visit(x, k, depth + 1));
  };
  if (typeof args.range === "string") strings.push(`单元格范围：${args.range}`);
  if (Array.isArray(args.values)) {
    const rows = args.values.slice(0, 30);
    for (const row of rows) if (Array.isArray(row)) strings.push(row.map(cell => String(cell ?? "")).join(" ｜ "));
    if (args.values.length > rows.length) strings.push(`共 ${args.values.length} 行；其余内容请展开完整参数检查。`);
  }
  if (args.fields && typeof args.fields === "object" && !Array.isArray(args.fields)) for (const [name, value] of Object.entries(args.fields)) strings.push(`${name}：${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  if (Array.isArray(args.records)) strings.push(`批量变更 ${args.records.length} 条记录；请展开完整参数检查各条内容。`);
  if (Array.isArray(args.assignee_open_ids)) strings.push(`添加负责人：${args.assignee_open_ids.join("、")}`);
  if (Array.isArray(args.attendees)) strings.push(`添加 ${args.attendees.length} 位参与人，可能发送日程邀请；请检查完整名单。`);
  visit(args); const text = strings.join("\n");
  return text.length > 6000 ? `${text.slice(0, 6000)}\n预览较长，其余内容请展开完整参数检查。` : text;
}
function proposalTarget(args: Record<string, unknown>, fallback: string): string {
  const keys = ["title", "name", "document_id", "file_token", "spreadsheet_token", "app_token", "task_guid", "calendar_id", "receive_id", "approval_code"];
  const base = keys.map(key => args[key]).find(value => typeof value === "string" && value.length > 0);
  return [base ?? fallback, args.table_id, args.range, args.event_id, args.comment_id].filter(value => typeof value === "string" && value.length > 0).join(" · ");
}
function FeishuDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return <details open className="feishuDisclosure" data-expanded={expanded}>
    <summary aria-expanded={expanded} onClick={e => { e.preventDefault(); setExpanded(value => !value); }}>{title}</summary>
    <div className="feishuDisclosureCollapse" inert={!expanded} aria-hidden={!expanded}>
      <div className="feishuDisclosureContent">{children}</div>
    </div>
  </details>;
}
export function FeishuOffice({ userId, threadId, inline = false, visible = true, onClose }: { userId: string; threadId?: string; inline?: boolean; visible?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(inline), [present, setPresent] = useState(inline);
  const [status, setStatus] = useState<Status>(), [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [confirmationNotice, setConfirmationNotice] = useState("");
  const priorFocus = useRef<HTMLElement | null>(null), dialog = useRef<HTMLElement>(null), pending = useRef(new Set<AbortController>());
  const refreshSequence = useRef(0), lastAuthNotice = useRef("");
  const refresh = async (signal?: AbortSignal) => {
    const sequence = ++refreshSequence.current;
    try { const [s, p] = await Promise.all([request<Status>("status", "GET", undefined, signal), request<{ proposals: Proposal[] }>("proposals", "GET", undefined, signal)]); if (!signal?.aborted && sequence === refreshSequence.current) { setStatus(s); setProposals(p.proposals); } }
    catch (e) { if (!signal?.aborted && sequence === refreshSequence.current) setError(e instanceof Error ? e.message : "无法读取连接状态"); }
  };
  useEffect(() => {
    if (inline) return;
    const handler = () => { priorFocus.current = document.activeElement as HTMLElement; setError(""); setOpen(true); setPresent(true); };
    window.addEventListener("codex:open-feishu", handler);
    return () => window.removeEventListener("codex:open-feishu", handler);
  }, [inline]);
  useEffect(() => { refreshSequence.current++; lastAuthNotice.current = ""; setOpen(inline); setPresent(inline); setStatus(undefined); setProposals([]); setError(""); setConfirmationNotice(""); for (const c of pending.current) c.abort(); }, [userId, threadId, inline]);
  useEffect(() => {
    const controller = new AbortController();
    const receive = (notice: unknown) => {
      if (!notice || typeof notice !== "object") return;
      const event = notice as { userId?: string; nonce?: string };
      if (event.userId !== userId || typeof event.nonce !== "string" || event.nonce === lastAuthNotice.current) return;
      lastAuthNotice.current = event.nonce; setError(""); void refresh(controller.signal);
    };
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("codex-feishu-auth") : undefined;
    if (channel) channel.onmessage = event => receive(event.data);
    const storage = (event: StorageEvent) => { if (event.key !== "codex:feishu-auth-updated" || !event.newValue) return; try { receive(JSON.parse(event.newValue)); } catch { /* Ignore unrelated malformed storage data. */ } };
    window.addEventListener("storage", storage);
    return () => { controller.abort(); channel?.close(); window.removeEventListener("storage", storage); };
  }, [userId]);
  useEffect(() => () => { for (const c of pending.current) c.abort(); }, []);
  useEffect(() => {
    if (inline && !visible) return;
    if (!open) { if (!present) return; const timer = window.setTimeout(() => { setPresent(false); priorFocus.current?.focus(); }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 360); return () => clearTimeout(timer); }
    const controller = new AbortController(); void refresh(controller.signal);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(controller.signal); }, 5000);
    const activate = () => { if (!document.hidden) void refresh(controller.signal); };
    document.addEventListener("visibilitychange", activate); window.addEventListener("focus", activate);
    dialog.current?.focus();
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", activate); window.removeEventListener("focus", activate); };
  }, [open, visible, inline, threadId]);
  const execute = async (fn: (signal: AbortSignal) => Promise<unknown>, refreshAfter = true) => {
    const c = new AbortController(); pending.current.add(c); setBusy(true); setError("");
    try { await fn(c.signal); if (!c.signal.aborted && refreshAfter) await refresh(c.signal); } catch (e) { if (!c.signal.aborted) setError(e instanceof Error ? e.message : "操作失败"); }
    finally { pending.current.delete(c); if (!c.signal.aborted) setBusy(false); }
  };
  const confirmProposal = (proposal: Proposal, approved: boolean) => void execute(async signal => {
    setConfirmationNotice("");
    ++refreshSequence.current;
    setProposals(current => current.map(p => p.id === proposal.id ? { ...p, status: "executing" } : p));
    try {
      const result = await request<{ ok?: boolean; cancelled?: boolean }>(`proposals/${proposal.id}/confirm`, "POST", { approved }, signal);
      if (signal.aborted) return;
      if (approved ? result.ok !== true : result.cancelled !== true) throw new Error("执行结果尚未确认，请刷新核对，不要重复提交。");
      ++refreshSequence.current;
      setProposals(current => current.map(p => p.id === proposal.id ? { ...p, status: approved ? "done" : "cancelled" } : p));
      setConfirmationNotice(approved ? "本项操作已执行成功。" : "已取消本项操作，没有执行写入。");
    } catch (error) {
      if (!signal.aborted) {
        ++refreshSequence.current;
        setProposals(current => current.map(p => p.id === proposal.id ? { ...p, status: "uncertain" } : p));
        await refresh(signal);
      }
      throw error;
    }
  }, false);
  if (!present) return null;
  const activeProposals = proposals.filter(p => (!threadId || p.threadId === threadId) && ["pending", "executing", "uncertain", "failed"].includes(p.status));
  const close = () => inline ? onClose?.() : setOpen(false);
  const content = <section ref={dialog} tabIndex={-1} className={`feishuDialog${inline ? " feishuDocked" : ""}`} role={inline ? "region" : "dialog"} aria-modal={inline ? undefined : true} aria-label="飞书办公" onKeyDown={e => {
      if (e.key === "Escape") close();
      if (!inline && e.key === "Tab") { const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('summary,button:not([disabled]),a[href],input:not([disabled])') ?? []).filter(item => !item.closest('[inert]')); if (!items.length) return; const first = items[0], last = items[items.length - 1]; if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    }}>
      <header><span>飞书办公</span><div><button disabled={busy} title="刷新状态" aria-label="刷新状态" onClick={() => void execute(signal => refresh(signal))}><RefreshCw size={16} className={busy ? "feishuSpin" : ""} /></button><button aria-label={inline ? "收起飞书办公" : "关闭"} onClick={close}><X size={16} /></button></div></header>
      <div className="feishuBody">
        <p>{status?.connected ? `已连接 · ${status.identity ?? "本人飞书账号"}` : status?.configured ? "企业应用已配置，尚未完成本人授权。请点击「连接飞书」；应用审核通过不会自动连接个人账号。" : "等待管理员配置企业应用；尚未连接飞书。"}</p>
        {status?.needsAdditionalAuthorization && <p>申请范围已增加；旧授权仍可用，请点击「重新授权」开通新增功能。</p>}
        <div className="feishuActions">
          <button disabled={busy || !status?.configured} onClick={() => {
            const popup = window.open("about:blank", "_blank"); if (popup) popup.opener = null;
            void execute(async signal => { try { const data = await request<{ url: string }>("authorize", "POST", {}, signal); if (popup) popup.location.href = data.url; else window.location.assign(data.url); } catch (e) { popup?.close(); throw e; } });
          }}><ExternalLink size={14} />{status?.connected ? "重新授权" : "连接飞书"}</button>
          {status?.connected ? <button disabled={busy} onClick={() => { if (window.confirm("断开本人飞书连接并取消待确认操作？不会删除飞书中的文件。")) void execute(signal => request("connection", "DELETE", undefined, signal)); }}>断开连接</button> : null}
        </div>
        {error ? <p className="feishuError" role="alert">{error}</p> : null}
        {confirmationNotice ? <p className="feishuHint" role="status">{confirmationNotice}</p> : null}
        <section className="feishuPending" aria-label="待确认操作" aria-live="polite">
          <p className="feishuSectionTitle">待确认操作{activeProposals.length ? ` · ${activeProposals.length}` : ""}</p>
          {!status ? <p className="feishuHint">正在读取操作记录…</p> : !activeProposals.length ? <p className="feishuHint">暂无待确认操作。勾选技能只用于调用能力，不代表批准写入；过期预览请回原会话重新提交。</p> : null}
          {activeProposals.map(p => <article className="feishuProposal" key={p.id}>
            <strong>{p.summary}</strong><small>目标：{proposalTarget(p.args, p.operation)}</small>
            {p.actor ? <small>执行身份：{p.actor}</small> : null}
            {contentPreview(p.args) ? <div className="feishuPreview">{contentPreview(p.args)}</div> : null}
            <FeishuDisclosure title="检查完整改动参数"><pre>{JSON.stringify(p.args, null, 2)}</pre></FeishuDisclosure>
            {p.status === "pending" ? <div className="feishuActions"><button disabled={busy} onClick={() => confirmProposal(p, true)}>确认执行</button><button disabled={busy} onClick={() => confirmProposal(p, false)}>取消</button></div> : <p>{p.status === "executing" ? "正在执行，请勿重复提交。" : p.status === "failed" ? "飞书已明确拒绝此操作，没有执行修改。" : "结果待核实，请检查飞书后再决定是否重新操作。"}</p>}
            {["failed", "uncertain"].includes(p.status) ? <div className="feishuActions"><button disabled={busy} onClick={() => void execute(signal => request(`proposals/${p.id}/dismiss`, "POST", {}, signal))}>关闭此提示</button><small>仅移除本地提示，不重试、不撤销飞书操作，也不断开授权。</small></div> : null}
          </article>)}
        </section>
        <p className="feishuHint">在 / 中选择「飞书办公」并描述需求；模型提交写入预览后，回到这里检查并点击「确认执行」。</p>
        {status?.scopes ? <FeishuDisclosure title="已授权范围"><p className="feishuScopes">{status.scopes}</p></FeishuDisclosure> : null}
        {status?.connected ? <div className="feishuPermissionGroups">
          <div className="feishuPermissionGroup"><div className="feishuPermissionTags">{status.capabilities?.length ? status.capabilities.map(name => <span className="feishuPermissionTag" key={name}>{name}</span>) : <span className="feishuHint">请查看已授权范围</span>}</div></div>
          {status.pendingVerificationCapabilities?.length ? <div className="feishuPermissionGroup"><span className="feishuSectionTitle">待核验权限</span><div className="feishuPermissionTags">{status.pendingVerificationCapabilities.map(name => <span className="feishuPermissionTag" key={name}>{name}</span>)}</div></div> : null}
          <p className="feishuHint">目标资源权限仍需实际读取验证。</p>
        </div> : null}
        {!status?.connected && status?.requestedScopes ? <FeishuDisclosure title="待申请范围（尚未授权）"><p className="feishuScopes">{status.requestedScopes}</p></FeishuDisclosure> : null}
        <FeishuDisclosure title="授权说明"><p>每位用户只需连接自己的飞书账号，不需要创建应用或填写密钥。新增功能需要重新授权；目标文档、群聊和企业流程仍受本人权限限制。</p><p>管理员可在 <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">飞书开放平台 → 当前应用</a> 管理权限和机器人能力。机器人启用、发布并加入目标群后，群消息功能才可用。</p></FeishuDisclosure>
        <FeishuDisclosure title="功能边界"><p>请假通过企业现有审批流程提交，不直接改写考勤。原生日报暂不支持直接提交，可生成草稿，经确认写入文档或发到群聊。</p></FeishuDisclosure>
      </div>
    </section>;
  return inline ? content : createPortal(<div className={`feishuScrim${open ? "" : " closing"}`} aria-hidden={!open} inert={!open} onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>{content}</div>, document.body);
}
