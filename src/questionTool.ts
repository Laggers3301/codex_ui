export interface ToolQuestion {
  id?: string;
  title: string;
  options: string[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseQuestionTool(toolName: string, input: unknown): ToolQuestion[] | null {
  if (!/(?:^|\.)request_user_input(?:_async)?$/.test(toolName.trim())) return null;
  let root: Record<string, unknown>;
  try {
    root = record(typeof input === "string" ? JSON.parse(input) : input);
  } catch {
    return null;
  }
  if (!Array.isArray(root.questions)) return null;
  const questions = root.questions.slice(0, 3).map((raw): ToolQuestion | null => {
    const question = record(raw);
    const title = [question.title, question.question].find((value) => typeof value === "string" && value.trim());
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 8).map((option) => {
          const value = record(option);
          if (value.isOther === true || value.is_other === true) return "";
          return typeof option === "string" ? option : typeof value.label === "string" ? value.label : "";
        }).map((value) => value.trim()).filter(Boolean)
      : [];
    // Async questions may intentionally omit options: they are free-text prompts.
    // The tool's {accepted:true} receipt is not an answer and is not parsed here.
    return typeof title === "string" && title.trim() ? { ...(typeof question.id === "string" ? { id: question.id } : {}), title: title.trim(), options } : null;
  }).filter((question): question is ToolQuestion => question !== null);
  return questions.length ? questions : null;
}

export interface UserInputRequest {
  id: string | number;
  method: string;
  params: { threadId: string; turnId: string; itemId: string; questions: unknown[] };
  questions: ToolQuestion[];
}

export function readUserInputRequest(value: unknown): UserInputRequest | null {
  const request = record(value);
  if ((typeof request.id !== "string" && typeof request.id !== "number")
    || (request.method !== "item/tool/requestUserInput" && request.method !== "tool/requestUserInput")) return null;
  const params = record(request.params);
  if (typeof params.threadId !== "string" || typeof params.turnId !== "string" || typeof params.itemId !== "string") return null;
  const questions = parseQuestionTool("request_user_input", params);
  if (!questions || !Array.isArray(params.questions) || questions.length !== params.questions.length
    || questions.some(question => !question.id) || new Set(questions.map(question => question.id)).size !== questions.length) return null;
  return { id: request.id, method: request.method, params: params as UserInputRequest["params"], questions };
}

export function userInputAnswerResult(request: UserInputRequest, answers: string[]): { answers: Record<string, { answers: string[] }> } {
  if (answers.length !== request.questions.length || answers.some(answer => !answer.trim())) throw new Error("请回答所有问题后再发送。");
  return { answers: Object.fromEntries(request.questions.map((question, index) => [question.id!, { answers: [answers[index].trim()] }])) };
}

export function synchronousQuestionHasResult(item: { tool?: unknown; status?: unknown; completed?: unknown; output?: unknown }): boolean {
  return typeof item.tool === "string" && /(?:^|\.)request_user_input$/.test(item.tool.trim())
    && (item.completed === true || ["completed", "failed", "declined"].includes(String(item.status)) || Boolean(item.output));
}

/** App-server history can place function arguments in `command`, not `input`. */
export function parseQuestionToolItem(item: { tool?: unknown; input?: unknown; command?: unknown }): ToolQuestion[] | null {
  const toolName = typeof item.tool === "string" ? item.tool : "";
  const input = typeof item.input === "string"
    ? item.input.trim() ? item.input : item.command
    : item.input ?? item.command;
  return parseQuestionTool(toolName, input);
}

/** A question is no longer pending once a later user message is in the transcript. */
export function questionHasLaterUserMessage(
  items: Array<{ id?: unknown; type?: unknown; role?: unknown }>,
  questionItemId: string
): boolean {
  const questionIndex = items.findIndex((item) => item.id === questionItemId);
  if (questionIndex < 0) return false;
  return items.slice(questionIndex + 1).some((item) => {
    const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
    const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
    return type === "usermessage" || type === "user" || role === "user";
  });
}
