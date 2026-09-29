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
          return typeof option === "string" ? option : typeof value.label === "string" ? value.label : "";
        }).map((value) => value.trim()).filter(Boolean)
      : [];
    return typeof title === "string" && title.trim() && options.length ? { title: title.trim(), options } : null;
  }).filter((question): question is ToolQuestion => question !== null);
  return questions.length ? questions : null;
}
