import { describe, expect, it } from "vitest";
import { parseQuestionTool, parseQuestionToolItem, questionHasLaterUserMessage } from "./questionTool";

describe("question tool presentation", () => {
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
