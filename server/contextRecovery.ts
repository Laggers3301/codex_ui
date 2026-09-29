export const contextRecoveryMessagePrefix = "<codex_internal_context_recovery>";

const genericContextLossReplies = [
  "what would you like me to work on",
  "ready what would you like me to work on",
  "understood what would you like me to work on"
];

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    : "";
}

export function isContextCompactionItem(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const token = normalizedText(item.tool ?? item.type ?? item.kind).replaceAll(" ", "");
  return token.includes("contextcompaction");
}

export function isGenericContextLossReply(value: unknown): boolean {
  const text = normalizedText(value);
  return genericContextLossReplies.includes(text);
}

/** Buffer only prefixes of the known bad reply while a recovery is pending. */
export function isPotentialGenericContextLossReply(value: unknown): boolean {
  const text = normalizedText(value);
  return Boolean(text) && genericContextLossReplies.some((candidate) => candidate.startsWith(text));
}

export function contextRecoveryPrompt(): string {
  return [
    contextRecoveryMessagePrefix,
    "A context-window transition just occurred inside an unfinished user turn.",
    "Continue the same active task now; this is not a new task.",
    "Before producing any final answer, read the newest active checkpoint listed in <context_window> with the notes tool, then use history if needed to recover the original user request and important tool results.",
    "Do not ask what to work on and do not emit a generic readiness response.",
    "Resume from the checkpoint's next concrete step and finish the user's requested work.",
    "</codex_internal_context_recovery>"
  ].join("\n");
}
