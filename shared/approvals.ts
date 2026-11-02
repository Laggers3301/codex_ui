export interface ApprovalRequest {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export function isApprovalRequest(method: unknown): boolean {
  return isMcpElicitationRequest(method) || (typeof method === "string" && method.endsWith("/requestApproval"));
}

export function isMcpElicitationRequest(method: unknown): boolean {
  return method === "mcpServer/elicitation/request";
}

/** Native MCP tool consent uses a form with no fields. Forms that need input or
 * device verification must never be accepted using an empty consent response. */
export function isMcpConsentRequest(request: ApprovalRequest): boolean {
  if (!isMcpElicitationRequest(request.method)
    || !["form", "openai/form", "openaiForm"].includes(String(request.params.mode))
    || typeof request.params.message !== "string" || !request.params.message.trim()
    || typeof request.params.serverName !== "string" || !request.params.serverName.trim()) return false;
  const schema = request.params.requestedSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const fields = schema as Record<string, unknown>;
  const properties = fields.properties;
  return fields.type === "object" && !!properties && typeof properties === "object" && !Array.isArray(properties)
    && Object.keys(properties).length === 0
    && (fields.required === undefined || (Array.isArray(fields.required) && fields.required.length === 0))
    && Object.keys(fields).every(key => ["type", "properties", "required", "title", "description", "$schema", "additionalProperties"].includes(key))
    && (fields.additionalProperties === undefined || typeof fields.additionalProperties === "boolean");
}

export function approvalDecisions(request: ApprovalRequest): ApprovalDecision[] {
  if (isMcpElicitationRequest(request.method)) return isMcpConsentRequest(request) ? ["decline", "cancel", "accept"] : ["decline", "cancel"];
  if (request.method === "item/claudeTool/requestApproval") return ["decline", "accept"];
  if (request.method === "item/permissions/requestApproval") return ["decline", "accept"];
  if (request.method === "item/fileChange/requestApproval") return ["decline", "accept"];
  if (request.method !== "item/commandExecution/requestApproval") return [];
  const available = request.params.availableDecisions;
  if (!Array.isArray(available)) return ["decline", "accept"];
  return (["decline", "cancel", "accept", "acceptForSession"] as const).filter(decision => available.includes(decision));
}

/** Translate a button choice using the server's pending request. Never accept a
 * client-supplied permission profile, wider grant scope, or policy amendment. */
export function approvalResponse(request: ApprovalRequest, result: unknown): unknown {
  const decision = result && typeof result === "object" ? (result as Record<string, unknown>).decision : undefined;
  if (!approvalDecisions(request).includes(decision as ApprovalDecision)) throw new Error("批准方式无效或当前请求不支持此选择，请重新核对批准请求。");
  if (isMcpElicitationRequest(request.method)) return { action: decision, content: decision === "accept" ? {} : null };
  if (request.method !== "item/permissions/requestApproval") return { decision };
  const requested = request.params.permissions;
  if (!requested || typeof requested !== "object" || Array.isArray(requested)) throw new Error("权限申请缺少具体范围，无法批准，请重新核对批准请求。");
  const profile = requested as Record<string, unknown>;
  return {
    permissions: decision === "accept"
      ? Object.fromEntries(["network", "fileSystem"].filter(key => profile[key] != null).map(key => [key, profile[key]]))
      : {},
    scope: "turn"
  };
}
