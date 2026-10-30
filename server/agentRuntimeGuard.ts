import { CLAUDE_NOT_CONNECTED, isReclaudeModel } from "../shared/agentRuntime.js";
import { AppError } from "./appErrors.js";

/** Called before spawning Codex, selecting an account, or saving a model.
 * Authorization/activation belongs to the later account-binding stage. */
export function assertCodexModelRequest(params: unknown): void {
  if (!params || typeof params !== "object") return;
  const p = params as Record<string, unknown>;
  const settings = (p.collaborationMode as { settings?: { model?: unknown } } | undefined)?.settings;
  const config = p.config as Record<string, unknown> | undefined;
  if ([p.model, p.defaultModel, settings?.model, config?.model].some(isReclaudeModel)) {
    throw new AppError("runtime_not_connected", CLAUDE_NOT_CONNECTED);
  }
}
