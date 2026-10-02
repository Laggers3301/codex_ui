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

export function isPlanOnlyContinuationReply(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 4_000) return false;

  const normalized = text.toLowerCase();
  const immediateNextStep = /(我现在|我这就|我马上|我接下来|我下一步|我会继续|现在就|现在去|这就|马上|接下来|下一步|然后|i(?:'?ll| will)? now|i am going to|next step)/.test(normalized);
  const promisedAction = /(落代码|修改|修复|改正|实现|补上|补齐|排查|处理|部署|构建|测试|验证|检查|执行|运行|跑一下|去跑|继续(?:工作|任务)?|run|test|build|verify|check|fix|implement|inspect|investigate)/.test(normalized);
  const waitsForUser = /(等(?:你|待|到)[^。！？\n]{0,24}(确认|回复|通知|说)|先等|需要你|请你(?:确认|回复|通知)|待确认|之后再开始)/.test(normalized);
  const finalResult = /(已(?:经|全部)?完成|完成了|任务结束|最终(?:答复|结论|结果)|结果如下|总结如下)/.test(normalized);

  return immediateNextStep && promisedAction && !waitsForUser && !finalResult;
}

export function continuationRecoveryPrompt(): string {
  return [
    "<codex_internal_continuation_recovery>",
    "The previous turn ended by promising the next concrete action, but it made no tool call and the app-server marked the turn complete.",
    "Continue immediately and perform that promised action with the appropriate tool.",
    "Do not send another planning-only final response.",
    "If the action is genuinely unnecessary or blocked by missing user input, finish with the result or the specific blocking question.",
    "</codex_internal_continuation_recovery>"
  ].join("\n");
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
