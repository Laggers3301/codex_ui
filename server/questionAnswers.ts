import { parseQuestionToolItem } from "../src/questionTool.js";
import type { ProjectStore } from "./db.js";
import { findThreadJsonlPathById } from "./threadFallback.js";
import { readIndexedThreadItem } from "./threadEventIndex.js";

/** Only include replies for question items on this bounded history page. */
export function questionAnswersForPage(store: ProjectStore, threadId: string, userId: string, thread: unknown): Record<string, unknown> {
  const turns = (thread as { turns?: Array<{ items?: Array<Parameters<typeof parseQuestionToolItem>[0] & { id: string }> }> } | null)?.turns;
  const answers: Record<string, unknown> = Object.create(null);
  for (const turn of turns ?? []) for (const item of turn.items ?? []) {
    if (!parseQuestionToolItem(item)) continue;
    const raw = item as Record<string, unknown>;
    for (const id of new Set([item.id, raw.callId, raw.call_id, raw.sourceItemId].filter((id): id is string => typeof id === "string" && Boolean(id)))) {
      const answer = store.getQuestionAnswer(threadId, id, userId);
      if (answer !== null) { answers[item.id] = answer; answers[id] = answer; break; }
    }
  }
  return answers;
}

/** Historical async tools have already returned their receipt. Deliver their
 * answer as a correlated tool output, rather than inventing a user message. */
export async function questionToolOutput(store: ProjectStore, threadId: string, itemId: string, answers: unknown) {
  let item = store.readTimelineItem(threadId, itemId);
  if (!item) {
    const file = await findThreadJsonlPathById(threadId);
    if (file) item = await readIndexedThreadItem(file, threadId, itemId, { preferCall: true });
  }
  const nativeAsync = String(item?.type).replace(/_/g, "").toLowerCase() === "agentmessage"
    && item?.delivery === "async" && Array.isArray(item.questions);
  const tool = nativeAsync ? "request_user_input_async"
    : [item?.tool, item?.toolName, item?.name].find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() ?? "";
  const questions = item ? parseQuestionToolItem(item) : null;
  if (!questions || !/(?:^|\.)request_user_input_async$/.test(tool)) {
    throw new Error("该提问的待回答请求尚未同步，请刷新会话后再回答。");
  }
  if (!Array.isArray(answers) || answers.length !== questions.length
    || answers.some(answer => typeof answer !== "string" || !answer.trim())) {
    throw new Error("请回答所有问题后再发送。");
  }
  const values = (answers as string[]).map(answer => answer.trim());
  const parts = tool.split(".");
  return {
    answers: values,
    toolOutput: {
      name: parts.pop()!, namespace: parts.join(".") || null, retain: true,
      output: JSON.stringify({ type: "codex_web_question_answer", itemId,
        questions: questions.map((question, index) => ({ id: question.id ?? String(index), question: question.title, answer: values[index] })) })
    }
  };
}
