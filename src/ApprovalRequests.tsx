import { approvalDecisions, type ApprovalDecision, type ApprovalRequest } from "../shared/approvals";

export function ApprovalRequests({ requests, waiting, checking, message, answering, operation, onRefresh, onAnswer }: {
  requests: ApprovalRequest[];
  waiting: boolean;
  checking: boolean;
  message?: string;
  answering: Record<string, boolean>;
  operation: (request: ApprovalRequest) => string;
  onRefresh: () => void;
  onAnswer: (request: ApprovalRequest, decision: ApprovalDecision) => void;
}) {
  if (!requests.length && !waiting) return null;
  return <section className="codexApprovalRequests" aria-label="待批准操作">
    {requests.map(request => {
      const params = request.params;
      const network = params.networkApprovalContext;
      const claude = request.method === "item/claudeTool/requestApproval";
      const permissions = request.method === "item/permissions/requestApproval";
      const fileChange = request.method === "item/fileChange/requestApproval";
      const title = claude ? `工具 ${String(params.toolName ?? "操作")}` : permissions ? "权限申请" : fileChange ? "文件修改" : network ? "网络访问" : request.method === "item/commandExecution/requestApproval" ? "命令执行" : "操作";
      const decisions = approvalDecisions(request);
      const detail = claude ? JSON.stringify(params.toolInput ?? {}, null, 2) : operation(request);
      return <div className="codexApprovalCard" role="alert" aria-label={`批准${title}`} key={String(request.id)}>
        <strong>{claude ? "Claude" : "Codex"} 等待批准{title}</strong>
        {typeof params.reason === "string" && params.reason ? <p>申请原因：{params.reason}</p> : null}
        {detail ? <pre>{detail}</pre> : permissions || network || params.grantRoot ? null : <p>运行时未提供具体操作内容。可以先重新核对，再决定是否批准。</p>}
        {typeof params.cwd === "string" ? <p>工作目录：<code>{params.cwd}</code></p> : null}
        {params.grantRoot ? <p>申请本会话的写入目录：<code>{String(params.grantRoot)}</code></p> : null}
        {network ? <pre>网络目标：{JSON.stringify(network, null, 2)}</pre> : null}
        {permissions ? <><p>仅允许本轮使用下列权限：</p><pre>{JSON.stringify(params.permissions, null, 2)}</pre></> : params.additionalPermissions ? <><p>本次操作额外申请的权限：</p><pre>{JSON.stringify(params.additionalPermissions, null, 2)}</pre></> : null}
        {!decisions.length ? <p>当前页面尚不支持此批准类型：<code>{request.method}</code>。没有发送批准决定。</p> : null}
        <div className="codexApprovalActions">
          {answering[String(request.id)] ? <span role="status">正在提交决定…</span> : null}
          {decisions.map(decision => <button type="button" key={decision} disabled={Boolean(answering[String(request.id)])} onClick={() => onAnswer(request, decision)}>
            {decision === "decline" ? "拒绝" : decision === "cancel" ? "取消操作" : decision === "acceptForSession" ? "允许本会话" : permissions ? "允许本轮所列权限" : fileChange ? "批准文件修改" : "仅批准这次"}
          </button>)}
        </div>
      </div>;
    })}
    {!requests.length ? <p role="status">{message ?? "运行时报告正在等待批准，但页面尚未收到具体操作和批准按钮。请先重新核对批准请求。"}</p> : null}
    {requests.length && message ? <p role="status">{message}</p> : null}
    <button className="codexApprovalRefresh" type="button" onClick={onRefresh} disabled={checking}>{checking ? "正在核对批准请求…" : "重新核对批准请求"}</button>
  </section>;
}
