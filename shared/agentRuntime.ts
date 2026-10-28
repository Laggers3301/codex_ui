/** Runtime identity is separate from the model's display name. ReClaude models
 * use a reserved prefix so they can never fall through to a Codex provider. */
export type AgentRuntime = "codex" | "claude-code";
export type ModelAvailability = "ready" | "not-connected";
export interface RuntimeModelMetadata {
  runtime?: AgentRuntime;
  availability?: ModelAvailability;
  unavailableReason?: string;
}

export const CLAUDE_NOT_CONNECTED = "尚未连接 ReClaude 账号，暂时无法使用 Claude。账号连接后需验证可用模型。";

export function isReclaudeModel(model: unknown): boolean {
  return typeof model === "string" && model.startsWith("reclaude-");
}

export function modelIsAvailable(profile: RuntimeModelMetadata): boolean {
  return profile.availability !== "not-connected";
}

/** These are model-family previews, not a claim of account entitlement. No
 * Claude reasoning tiers are advertised; effort is a legacy UI storage field. */
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
