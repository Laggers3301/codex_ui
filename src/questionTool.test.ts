import { describe, expect, it } from "vitest";
import { parseQuestionTool, parseQuestionToolItem, questionHasLaterUserMessage, readUserInputRequest, userInputAnswerResult, synchronousQuestionHasResult } from "./questionTool";

describe("question tool presentation", () => {
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

  it("does not treat an async accepted receipt as a user answer", () => {
    const items = [
      { id: "question", type: "toolCall" },
      { id: "receipt", type: "toolCallOutput", output: '{"accepted":true}' },
      { id: "continuation", type: "agentMessage" }
    ];
    expect(questionHasLaterUserMessage(items, "question")).toBe(false);
    expect(questionHasLaterUserMessage([...items, { id: "reply", type: "userMessage" }], "question")).toBe(true);
    expect(parseQuestionTool("request_user_input_async", { accepted: true })).toBeNull();
  });

  it("stops presenting a question after a later user reply, including within the same turn", () => {
    const items = [
      { id: "first", type: "userMessage" },
      { id: "question", type: "toolCall" },
      { id: "tool-output", type: "toolCallOutput" },
      { id: "answer", type: "userMessage" }
    ];
    expect(questionHasLaterUserMessage(items.slice(0, 3), "question")).toBe(false);
    expect(questionHasLaterUserMessage(items, "question")).toBe(true);
    expect(questionHasLaterUserMessage(items, "missing")).toBe(false);
  });
});
