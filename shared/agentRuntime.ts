/** Runtime identity is separate from the model's display name. ReClaude models
 * use a reserved prefix so they can never fall through to a Codex provider. */
export type AgentRuntime = "codex" | "claude-code";
export type ModelAvailability = "ready" | "not-connected" | "disabled";
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export interface RuntimeModelMetadata {
  runtime?: AgentRuntime;
  nativeModelId?: string;
  availability?: ModelAvailability;
  unavailableReason?: string;
  supportedEffortLevels?: ClaudeEffort[];
}

export const CLAUDE_NOT_CONNECTED = "尚未连接 ReClaude 账号，暂时无法使用 Claude。账号连接后需验证可用模型。";

export function isReclaudeModel(model: unknown): boolean {
  return typeof model === "string" && model.startsWith("reclaude-");
}

export function claudeBranchName(sourceName:string):string {
  let name=sourceName.trim(),previous='';
  while(name!==previous){previous=name;name=name.replace(/\s*(?:·\s*(?:迁移|分支)|-\s*ReClaude|-\s+\d{4,6})\s*$/i,'').trim();}
  return `${name||'会话'} - ReClaude`;
}

export function modelIsAvailable(profile: RuntimeModelMetadata): boolean {
  return profile.availability !== "not-connected" && profile.availability !== "disabled";
}

/** Unconnected previews do not advertise effort tiers or account entitlement.
 * Connected profiles use the native client's supportedEffortLevels. */
export function claudePendingProfiles() {
  return ["Sonnet", "Opus", "Haiku"].map((family, index) => ({
    id: `reclaude-${family.toLowerCase()}:medium`,
    model: `reclaude-${family.toLowerCase()}`,
    label: `Claude ${family}`,
    displayName: `Claude ${family}`,
    effort: "medium" as const,
    priority: 1000 + index,
    runtime: "claude-code" as const,
    availability: "not-connected" as const,
    unavailableReason: CLAUDE_NOT_CONNECTED
  }));
}
