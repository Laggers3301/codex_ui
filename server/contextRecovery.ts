export const contextRecoveryMessagePrefix = "<codex_internal_context_recovery>";
export const continuationRecoveryMessagePrefix = "<codex_internal_continuation_recovery>";

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
  // This is a conservative guard for a short, planning-only handoff, not a
  // general detector of "next steps" in a delivered answer. Advice, examples,
  // tables and full reports must never start an unsolicited extra turn.
  if (!text || text.length > 600 || /```|~~~|^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)、]\s|\|)/m.test(text)) return false;
  const prose = text.replace(/^\s*>.*$/gm, "").replace(/`[^`\n]*`/g, "").replace(/[*_]/g, "").trim();
  if (!prose) return false;
  const paragraphs = prose.split(/\n\s*\n/);
  if (paragraphs.length > 3) return false;
  const normalized = prose.toLowerCase().replace(/’/g, "'");
  const waitsForUser = /(等(?:你|待|到)[^。！？\n]{0,24}(确认|回复|通知|说)|先等|需要你|请你(?:确认|回复|通知)|待确认|之后再开始|\b(?:if you|once you|await(?:ing)?|wait for|need your)\b)/.test(normalized);
  const finalResult = /(已(?:经|全部)?(?:完成|修复|解决|部署)|完成了|任务结束|最终(?:答复|结论|结果)|结果如下|总结如下|\b(?:all done|task complete|tests? passed)\b)/.test(normalized);
  if (waitsForUser || finalResult) return false;

  const tail = paragraphs.at(-1)!.trim().toLowerCase().replace(/’/g, "'");
  if (tail.length > 180 || /(建议|推荐|可以|考虑|如果|是否|要不要|以后|明天|不会|不打算|无需|不需要|不用|不必|暂不|\b(?:recommend|could|should|tomorrow|later|won't|not going to)\b)/.test(tail)) return false;
  const sentences = tail.split(/[。！？!?\n]+|\.\s+/).map((part) => part.trim()).filter(Boolean);
  const promise = sentences.at(-1) ?? "";
  const actor = /^(?:(?:好(?:的)?|明白|收到|okay|ok)[，,:： ]*)?(?:(?:现在|接下来|下一步|然后)[，, ]*)?我(?:现在|这就|马上|立刻|接下来|下一步|会继续|将立即|先|(?:会|将)(?:先|马上|立即)?|去|来)|^(?:(?:okay|ok)[,: ]*)?(?:next[,]?\s+)?i(?:'ll| will)\s+(?:now|immediately|next)\b|^i(?:'m| am)\s+(?:now\s+)?going to\b/;
  const action = /(落代码|修改|修复|改正|实现|补上|补齐|排查|处理|部署|构建|测试|验证|检查|执行|运行|跑一下|去跑|继续(?:工作|任务)?|\b(?:run|test|build|verify|check|fix|implement|inspect|investigate)\b)/;
  return actor.test(promise) && action.test(promise);
}

export function continuationRecoveryPrompt(): string {
  return [
    continuationRecoveryMessagePrefix,
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
