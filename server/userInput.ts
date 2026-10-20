export function isUserInputRequest(method: unknown): boolean {
  return method === "item/tool/requestUserInput" || method === "tool/requestUserInput";
}

/** Return only answers to the questions in this pending native request. */
export function validateUserInputResponse(params: unknown, result: unknown): { answers: Record<string, { answers: string[] }> } {
  const questions = (params as { questions?: Array<{ id?: unknown }> } | null)?.questions;
  const answers = (result as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(questions) || !questions.length || !answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error("请回答所有问题后再发送。");
  }
  const entries = questions.map((question) => {
    if (typeof question.id !== "string" || !question.id) throw new Error("提问缺少问题编号，请刷新会话。");
    const answer = (answers as Record<string, unknown>)[question.id] as { answers?: unknown } | undefined;
    if (!Array.isArray(answer?.answers) || !answer.answers.length || answer.answers.some(value => typeof value !== "string" || !value.trim())) {
      throw new Error("请回答所有问题后再发送。");
    }
    return [question.id, { answers: answer.answers.map(value => (value as string).trim()) }] as const;
  });
  const ids = new Set(entries.map(([id]) => id));
  if (ids.size !== questions.length || Object.keys(answers).some(id => !ids.has(id))) {
    throw new Error("答案与当前问题不匹配，请刷新会话。");
  }
  return { answers: Object.fromEntries(entries) };
}
