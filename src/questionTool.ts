export interface ToolQuestion {
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
    return typeof title === "string" && title.trim() && Array.isArray(question.options) ? { title: title.trim(), options } : null;
  }).filter((question): question is ToolQuestion => question !== null);
  return questions.length ? questions : null;
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
