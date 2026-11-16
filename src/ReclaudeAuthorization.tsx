import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cancelReclaudeAuthorization, readReclaudeAuthorization, readReclaudeOrganizations, startReclaudeAuthorization } from "./api";
import { newReclaudeAuthorizationRequestId, reclaudeAuthorizationPending, reclaudeAuthorizationUrl, type ReclaudeAuthorizationAction, type ReclaudeAuthorizationStatus } from "../shared/reclaudeAuthorization";
import "./reclaudeAuthorization.css";
import { usePopoverEscape } from "./usePopoverEscape";
import { BranchChoice } from "./BranchChoice";
import { X } from "./PanelIcons";
import "./taskNotificationSettings.css";

const phases = {
  starting:"正在准备操作…", binding:"正在绑定组织…", switching:"正在切换默认组织…", syncing:"正在同步本机历史与记忆…", logging_out:"正在退出所选账号…", waiting_authorization:"请在认证页面完成登录并批准此设备。",
  verifying:"正在确认新账号身份…", completed:"认证完成", failed:"认证未完成", cancelled:"认证已取消", interrupted:"认证已中断"
};
export function ReclaudeAuthorizationDialog({ orgId, onClose, onAuthenticated }: {
  orgId?: string; onClose: () => void; onAuthenticated: () => void;
}) {
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function close() {
    if (closeTimer.current) return;
    setClosing(true);
    closeTimer.current = setTimeout(onClose, 220);
  }
  usePopoverEscape(true, close);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  const [status, setStatus] = useState<ReclaudeAuthorizationStatus | null>(null);
  const [selected, setSelected] = useState(orgId ?? "");
  const [action, setAction] = useState<ReclaudeAuthorizationAction>(orgId ? "reauthenticate" : "bind");
  const [manualOrgId, setManualOrgId] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [syncHistory, setSyncHistory] = useState(false);
  const targetOrgId = selected === "manual" ? manualOrgId.trim() : selected;
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState("");
  const popup = useRef<Window | null>(null), openedUrl = useRef(""), completed = useRef("");
  const revision = useRef(0);
  const active = status?.operation && reclaudeAuthorizationPending(status.operation.phase);
  const operation = status?.operation;
  async function refreshOrganizations() {
    setRefreshing(true); setError("");
    const current = ++revision.current;
    try { const result = await readReclaudeOrganizations(); if (revision.current === current) setStatus(result.data); }
    catch (error) { setError(error instanceof Error ? error.message : "组织列表暂不可用。"); }
    finally { setRefreshing(false); }
  }
  useEffect(() => { void refreshOrganizations(); }, []);
  useEffect(() => {
    let disposed = false, pending = false;
    const controller = new AbortController();
    const read = async () => {
      if (pending) return; pending = true;
      const startedAtRevision = revision.current;
      try { const result = await readReclaudeAuthorization(controller.signal); if (!disposed && startedAtRevision === revision.current) setStatus(result.data); }
      catch (error) { if (!disposed) setError(error instanceof Error ? error.message : "暂未读到认证状态。"); }
      finally { pending = false; }
    };
    void read(); const timer = setInterval(read, 1500);
    return () => { disposed = true; controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!selected && status?.organizations.length) setSelected(status.organizations.find(row => row.connected)?.orgId ?? status.organizations[0].orgId);
  }, [status, selected]);
  useEffect(() => {
    if (!operation?.owned) return;
    const url = operation.authorizationUrl && reclaudeAuthorizationUrl(operation.authorizationUrl);
    if (url && openedUrl.current !== url && popup.current && !popup.current.closed) {
      popup.current.location.replace(url); openedUrl.current = url;
    }
    if (operation.phase === "completed" && completed.current !== operation.id) { completed.current = operation.id; onAuthenticated(); }
  }, [operation, onAuthenticated]);
  const begin = async () => {
    if (submitting || active || !/^[0-9]{1,20}$/.test(targetOrgId)) return;
    revision.current++;
    // The user gesture opens the window now; asynchronous device-flow polling
    // may only navigate this window, avoiding popup blockers on the real URL.
    const windowRef = action === "use" ? null : window.open("about:blank", "_blank");
    popup.current = windowRef; openedUrl.current = "";
    if (windowRef) { windowRef.opener = null; windowRef.document.title = "ReClaude 认证"; windowRef.document.body.textContent = "正在准备 ReClaude 认证页面…"; }
    setSubmitting(true); setError("");
    try { const result = await startReclaudeAuthorization(targetOrgId, newReclaudeAuthorizationRequestId(), action, action === "use" && syncHistory && !!status?.canSyncHistory); revision.current++; setStatus(result.data); }
    catch (error) {
      windowRef?.close(); setError(error instanceof Error ? error.message : "认证暂未启动。");
      // A lost HTTP acknowledgement is reconciled by status polling, never by
      // automatically submitting another logout/login operation.
    } finally { setSubmitting(false); }
  };
  const cancel = async () => {
    if (!operation?.owned) return;
    revision.current++;
    setSubmitting(true); setError("");
    try { const result = await cancelReclaudeAuthorization(operation.id); revision.current++; setStatus(result.data); popup.current?.close(); }
    catch (error) { setError(error instanceof Error ? error.message : "暂未能取消认证。"); }
    finally { setSubmitting(false); }
  };
  const link = operation?.owned && operation.authorizationUrl ? reclaudeAuthorizationUrl(operation.authorizationUrl) : null;
  const content = <div className={`taskNotificationScrim reclaudeAuthScrim${closing ? " uiClosing" : ""}`} aria-hidden={closing} inert={closing} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="taskNotificationDialog reclaudeAuthDialog" role="dialog" aria-modal="true" aria-label="ReClaude 组织管理">
      <header><h2>ReClaude 组织管理</h2><button type="button" className="taskNotificationIcon" aria-label="关闭组织管理" onClick={close}><X size={16}/></button></header>
      <div className="reclaudeOrganizationFields">
        <BranchChoice label="操作" value={action} onChange={value => { setAction(value as ReclaudeAuthorizationAction); if (selected === "manual" && value !== "bind") setSelected(status?.organizations[0]?.orgId ?? ""); }} disabled={!!active || submitting}
          options={[{value:"bind",label:"绑定新组织"},{value:"use",label:"切换默认组织"},{value:"reauthenticate",label:"重新认证已有组织"}]}/>
        <p>{action === "bind" ? "新增组织绑定，保留当前默认组织。完成后可在模型菜单中选择新组织。" : action === "use" ? "切换之后新启动的客户端使用的默认组织。已有网页会话沿用原组织；需要更换当前会话时，可选择目标模型或创建分支。" : "将退出所选共享账号并重新登录，可能暂时中断使用该账号的会话。原历史保留。"}</p>
        <BranchChoice label="组织" value={selected} onChange={setSelected} disabled={!!active || submitting}
          options={[...(status?.organizations ?? []).map(row => ({value:row.orgId,label:`${row.label} · #${row.orgId}${row.current ? " · 当前默认" : ""}${row.bound ? "" : " · 未绑定"}`,disabled:action === "use" && !row.connected})), ...(action === "bind" ? [{value:"manual",label:"输入其他组织编号"}] : [])]}/>
        {action === "bind" && selected === "manual" ? <label>组织编号<input inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={20} value={manualOrgId} onChange={event => setManualOrgId(event.target.value)} disabled={!!active || submitting}/></label> : null}
        {action === "use" ? <>
          <label className="reclaudeSyncOption"><input type="checkbox" checked={syncHistory && !!status?.canSyncHistory} onChange={event => setSyncHistory(event.target.checked)} disabled={!status?.canSyncHistory || !!active || submitting}/>同步本机历史与记忆</label>
          <p>{status?.canSyncHistory ? "复制旧组织中缺少的记录，不覆盖目标已有文件。旧组织有活跃进程时停止同步。" : "此实例尚未配置历史同步程序，或无法确认旧组织；可以单独切换默认组织。"}</p>
        </> : null}
        <button className="taskNotificationTest" type="button" onClick={() => void refreshOrganizations()} disabled={refreshing || !!active || submitting}>{refreshing ? "正在刷新组织…" : "刷新组织列表"}</button>
      </div>
      {!status ? <p role="status">正在读取账号状态…</p> : !status.enabled ? <p role="status">当前服务尚未启用重新认证。</p> : null}
      {operation ? <div className="reclaudeAuthStatus" role="status">
        <strong>{phases[operation.phase]}</strong>
        {active && !operation.owned ? <p>另一位用户正在重新认证共享账号，请等待完成。</p> : operation.message ? <p>{operation.message}</p> : null}
        {link ? <a href={link} target="_blank" rel="noopener noreferrer">打开认证页面</a> : null}
      </div> : null}
      {error ? <p className="reclaudeAuthError" role="alert">{error}</p> : null}
      {status?.organizationError ? <p className="reclaudeAuthError" role="status">{status.organizationError}</p> : null}
      <footer>
        {active && operation?.owned ? <button type="button" className="taskNotificationTest" onClick={() => void cancel()} disabled={submitting}>取消认证</button> : null}
        <button type="button" className="taskNotificationTest" onClick={() => void begin()} disabled={!status?.enabled || !/^[0-9]{1,20}$/.test(targetOrgId) || action === "use" && !status.organizations.find(row => row.orgId === targetOrgId)?.connected || !!active || submitting}>{submitting ? "正在处理…" : action === "bind" ? "绑定组织" : action === "use" ? "切换默认组织" : "退出并重新登录"}</button>
      </footer>
    </section>
  </div>;
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
