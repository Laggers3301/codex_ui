import { describe, expect, it } from "vitest";
import { parseQuestionTool, parseQuestionToolItem, questionHasAnswer, questionIsGenerating, readUserInputRequest, userInputAnswerResult, synchronousQuestionHasResult, readLiveQuestionNotification } from "./questionTool";

describe("question tool presentation", () => {
  it("shows generation only for an unfinished question without an answer receipt", () => {
    expect(questionIsGenerating({ tool: "request_user_input_async", completed: false })).toBe(true);
    const receipt = JSON.stringify({ type: "codex_web_question_answer", itemId: "original-question" });
    expect(questionIsGenerating({ tool: "request_user_input_async", completed: true, output: receipt })).toBe(false);
    expect(questionIsGenerating({ tool: "request_user_input_async", aggregatedOutput: receipt })).toBe(false);
    expect(questionIsGenerating({ tool: "request_user_input", status: "completed" })).toBe(false);
    expect(questionIsGenerating({ tool: "request_user_input_async", completed: true })).toBe(false);
    expect(questionIsGenerating({ tool: "exec", completed: false })).toBe(false);
  });
  it("preserves the native async agentMessage metadata on started, before any history or tool receipt", () => {
    const item = { type: "agentMessage", id: "call-native-q", delivery: "async", text: "请提供路径", questions: [{ title: "请提供路径", options: null }] };
    const event = { method: "item/started", params: { threadId: "t", turnId: "r", item } };
    const live = readLiveQuestionNotification(event)!;
    expect(live).toMatchObject({ itemId: item.id, tool: "request_user_input_async", threadId: "t", turnId: "r", completed: false });
    expect(parseQuestionTool(live.tool, live.input)).toEqual([{ title: "请提供路径", options: [] }]);
    expect(parseQuestionToolItem(item)).toEqual([{ title: "请提供路径", options: [] }]);
    expect(readLiveQuestionNotification({ ...event, method: "item/completed" })).toMatchObject({ completed: true });
    expect(synchronousQuestionHasResult({ ...live, completed: true, output: '{"accepted":true}' })).toBe(false);
  });
  it("does not promote prose, JSON examples, unscoped events or accepted receipts", () => {
    const make = (item: unknown) => ({ method: "item/started", params: { threadId: "t", turnId: "r", item } });
    expect(readLiveQuestionNotification(make({ type: "agentMessage", id: "m", text: '{"questions":[{"title":"示例"}]}' }))).toBeNull();
    expect(readLiveQuestionNotification(make({ type: "agentMessage", id: "m", delivery: "async", questions: null }))).toBeNull();
    expect(readLiveQuestionNotification(make({ type: "functionCallOutput", id: "c", output: '{"accepted":true}' }))).toBeNull();
    expect(readLiveQuestionNotification({ method: "item/started", params: { item: { type: "agentMessage", id: "q", delivery: "async", questions: [] } } })).toBeNull();
  });
  it("waits for complete typed tool parameters without guessing from partial JSON", () => {
    const event = (input: string) => ({ method: "item/started", params: { threadId: "t", turnId: "r", item: { type: "functionCall", id: "q", name: "functions.request_user_input_async", arguments: input } } });
    const partial = readLiveQuestionNotification(event('{"questions":['))!;
    expect(partial.tool).toBe("functions.request_user_input_async");
    expect(parseQuestionTool(partial.tool, partial.input)).toBeNull();
    const full = readLiveQuestionNotification(event('{"questions":[{"title":"选一个","options":["A","B"]}]}'))!;
    expect(parseQuestionTool(full.tool, full.input)?.[0].options).toEqual(["A", "B"]);
  });
  it("reads native functionCall name/arguments, not arbitrary model JSON", () => {
    const args = JSON.stringify({ questions: [{ title: "允许独立浏览器验收吗？", options: ["允许", "暂不"] }] });
    expect(parseQuestionToolItem({ name: "request_user_input_async", arguments: args })).toEqual([{ title: "允许独立浏览器验收吗？", options: ["允许", "暂不"] }]);
    expect(parseQuestionToolItem({ name: "exec", arguments: args })).toBeNull();
    expect(parseQuestionToolItem({ arguments: args })).toBeNull();
  });
  it("returns multiple choices by their native IDs, including a free-text answer with newlines", () => {
    const request = readUserInputRequest({ id: "pool-8", method: "item/tool/requestUserInput", params: {
      threadId: "thread-a", turnId: "turn-a", itemId: "call-q", questions: [
        { id: "robot", question: "请选择范围", options: [{ label: "A" }] },
        { id: "camera", question: "请选择范围", options: null }
      ]
    } })!;
    expect(request.questions.map(question => question.id)).toEqual(["robot", "camera"]);
    expect(userInputAnswerResult(request, ["A", "自定义\n另一行：内容"])).toEqual({ answers: {
      robot: { answers: ["A"] }, camera: { answers: ["自定义\n另一行：内容"] }
    } });
    expect(() => userInputAnswerResult(request, ["A"])).toThrow();
    expect(() => userInputAnswerResult(request, ["A", " "])).toThrow();
    expect(readUserInputRequest({ ...request, params: { ...request.params, questions: [{ question: "缺少编号" }] } })).toBeNull();
  });

  it("closes resolved synchronous questions while keeping async accepted receipts open", () => {
    expect(synchronousQuestionHasResult({ tool: "request_user_input", status: "completed" })).toBe(true);
    expect(synchronousQuestionHasResult({ tool: "request_user_input", completed: false })).toBe(false);
    expect(synchronousQuestionHasResult({ tool: "request_user_input_async", completed: true, output: '{"accepted":true}' })).toBe(false);
  });
  it("extracts choices from the async question tool without exposing its JSON", () => {
    const input = JSON.stringify({ questions: [{ title: "是否执行？", options: ["先测试", "立即启用"] }] });
    expect(parseQuestionTool("functions.request_user_input_async", input)).toEqual([{ title: "是否执行？", options: ["先测试", "立即启用"] }]);
  });

  it("supports the synchronous question schema and ignores unrelated tools", () => {
    const input = { questions: [{ question: "选哪一个？", options: [{ label: "A", description: "说明" }, { label: "B" }, { label: "Other", isOther: true }] }] };
    expect(parseQuestionTool("request_user_input", input)).toEqual([{ title: "选哪一个？", options: ["A", "B"] }]);
    expect(parseQuestionTool("exec", input)).toBeNull();
    expect(parseQuestionTool("request_user_input_async", "{broken")).toBeNull();
  });

  it("reads persisted function-call arguments from command", () => {
    const command = JSON.stringify({ questions: [{ title: "现在重启吗？", options: ["允许重启", "稍后再说"] }] });
    expect(parseQuestionToolItem({ tool: "request_user_input_async", command })).toEqual([{ title: "现在重启吗？", options: ["允许重启", "稍后再说"] }]);
  });

  it("renders free-text questions with missing or empty options", () => {
    expect(parseQuestionTool("request_user_input_async", { questions: [{ title: "请提供验收脚本路径" }] }))
      .toEqual([{ title: "请提供验收脚本路径", options: [] }]);
    expect(parseQuestionTool("request_user_input_async", { questions: [{ title: "如何继续？", options: [] }] }))
      .toEqual([{ title: "如何继续？", options: [] }]);
    expect(parseQuestionTool("request_user_input_async", { questions: [{ title: "   " }] })).toBeNull();
  });

  it("keeps every unanswered question open after an unrelated user message or async receipt", () => {
    const items = [
      { id: "question-a", type: "toolCall" },
      { id: "question-b", type: "toolCall" },
      { id: "receipt", type: "toolCallOutput", output: '{"accepted":true}' },
      { id: "reply", type: "userMessage" }
    ];
    expect(questionHasAnswer(items, "question-a")).toBe(false);
    expect(questionHasAnswer(items, "question-b")).toBe(false);
    expect(parseQuestionTool("request_user_input_async", { accepted: true })).toBeNull();
  });

  it("matches a tool answer to only its original question", () => {
    const items = [{ type: "toolCallOutput", output: JSON.stringify({
      type: "codex_web_question_answer", itemId: "question-a", questions: [{ answer: "A" }]
    }) }];
    expect(questionHasAnswer(items, "question-a")).toBe(true);
    expect(questionHasAnswer(items, "question-b")).toBe(false);
    expect(questionHasAnswer([{ aggregatedOutput: items[0].output }], "question-a")).toBe(true);
    expect(questionHasAnswer([{ output: "", aggregatedOutput: items[0].output }], "question-a")).toBe(true);
    expect(questionHasAnswer([{ output: "{broken" }], "question-a")).toBe(false);
  });
});
