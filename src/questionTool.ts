export interface ToolQuestion {
  id?: string;
  title: string;
  options: string[];
}

/** Display-only receipt decoding. accepted:true is never a user's answer. */
export function questionAnswerValues(questions: ToolQuestion[], value: unknown): string[] | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  const root = record(parsed);
  const values: unknown[] = Array.isArray(parsed) ? parsed
    : root.type === "codex_web_question_answer" && Array.isArray(root.questions)
      ? root.questions.map(row => record(row).answer)
      : questions.map((question, index) => {
          const answer = record(record(root.answers)[question.id ?? String(index)]).answers;
          return Array.isArray(answer) && answer.every(part => typeof part === "string") ? answer.join("\n") : null;
        });
  return values.length === questions.length && values.every(answer => typeof answer === "string" && answer.trim())
    ? (values as string[]).map(answer => answer.trim()) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function isQuestionToolName(value: unknown): value is string {
  return typeof value === "string" && /(?:^|\.)request_user_input(?:_async)?$/.test(value.trim());
}

/** Native history has an fc_* display id and a separate call_* reply id. */
export function questionItemId(item: { id?: unknown; callId?: unknown; call_id?: unknown }): string | null {
  return [item.callId, item.call_id, item.id].find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? null;
}

export function parseQuestionTool(toolName: string, input: unknown): ToolQuestion[] | null {
  if (!isQuestionToolName(toolName)) return null;
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

/** Native async questions are agentMessage items with explicit delivery/questions
 * metadata. Preserve that identity before the generic text stream drops it.
 * Never infer a question from assistant prose, JSON examples, or accepted:true. */
export function readLiveQuestionNotification(value: unknown) {
  const notification = record(value);
  if (typeof notification.method !== "string" || !/^item\/(?:[^/]+\/)?(?:started|completed)$/.test(notification.method)) return null;
  const params = record(notification.params), item = record(params.item);
  const nativeAsync = String(item.type).replace(/_/g, "").toLowerCase() === "agentmessage"
    && item.delivery === "async" && Array.isArray(item.questions);
  const tool = nativeAsync ? "request_user_input_async" : [item.tool, item.toolName, item.name].find(isQuestionToolName);
  const itemId = [item.callId, item.call_id, item.id, params.itemId].find(value => typeof value === "string" && value.trim());
  if (!tool || typeof itemId !== "string" || typeof params.threadId !== "string" || typeof params.turnId !== "string") return null;
  const input = nativeAsync ? JSON.stringify({ questions: item.questions }) : item.input ?? item.arguments ?? item.command ?? "";
  return {
    itemId, sourceItemId: typeof item.id === "string" ? item.id : itemId,
    threadId: params.threadId, turnId: params.turnId, tool,
    input: typeof input === "string" ? input : JSON.stringify(input),
    completed: notification.method.endsWith("/completed"),
  };
}

export interface UserInputRequest {
  id: string | number;
  method: string;
  params: { threadId: string; turnId: string; itemId: string; questions: unknown[]; isBlocking?: boolean };
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

/** An answer receipt or a finished tool cannot still be streaming a question. */
export function questionIsGenerating(item: { tool?: unknown; status?: unknown; completed?: unknown; output?: unknown; aggregatedOutput?: unknown }): boolean {
  return isQuestionToolName(item.tool) && item.completed !== true
    && !["completed", "failed", "declined", "cancelled", "canceled", "interrupted"].includes(String(item.status).toLowerCase())
    && !item.output && !item.aggregatedOutput;
}

/** App-server history can place function arguments in `command`, not `input`. */
export function parseQuestionToolItem(item: { type?: unknown; delivery?: unknown; questions?: unknown; tool?: unknown; name?: unknown; toolName?: unknown; arguments?: unknown; input?: unknown; command?: unknown }): ToolQuestion[] | null {
  if (String(item.type).replace(/_/g, "").toLowerCase() === "agentmessage" && item.delivery === "async" && Array.isArray(item.questions)) {
    return parseQuestionTool("request_user_input_async", { questions: item.questions });
  }
  // Native functionCall items use name/arguments; fallback history uses tool/command.
  // Only explicit tool identity is accepted, never arbitrary JSON in model prose.
  const toolName = [item.tool, item.toolName, item.name].find(value => typeof value === "string" && value.trim()) as string | undefined;
  const input = typeof item.input === "string"
    ? item.input.trim() ? item.input : item.command ?? item.arguments
    : item.input ?? item.command ?? item.arguments;
  return parseQuestionTool(toolName ?? "", input);
}

/** Only an explicitly correlated answer can resolve an asynchronous question. */
export function questionHasAnswer(
  items: Array<{ id?: unknown; type?: unknown; role?: unknown; output?: unknown; aggregatedOutput?: unknown }>,
  questionItemId: string
): boolean {
  return items.some(item => [item.output, item.aggregatedOutput].some(output => {
    try {
      const answer = record(typeof output === "string" ? JSON.parse(output) : output);
      return answer.type === "codex_web_question_answer" && answer.itemId === questionItemId;
    } catch { return false; }
  }));
}

/** @deprecated Kept for older host-side editor bundles during rolling deploys.
 * The current question UI uses explicit correlated answer receipts instead. */
export function questionHasLaterUserMessage(items: Array<{id?: unknown; type?: unknown; role?: unknown}>, questionItemId: string): boolean {
  const index = items.findIndex(item => item.id === questionItemId);
  return index >= 0 && items.slice(index + 1).some(item => {
    const type = String(item.type ?? '').toLowerCase(), role = String(item.role ?? '').toLowerCase();
    return type === 'usermessage' || type === 'user' || role === 'user';
  });
}
