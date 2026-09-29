import { describe, expect, it } from "vitest";
import { parseQuestionTool } from "./questionTool";

describe("question tool presentation", () => {
  it("extracts choices from the async question tool without exposing its JSON", () => {
    const input = JSON.stringify({ questions: [{ title: "是否执行？", options: ["先测试", "立即启用"] }] });
    expect(parseQuestionTool("functions.request_user_input_async", input)).toEqual([{ title: "是否执行？", options: ["先测试", "立即启用"] }]);
  });

  it("supports the synchronous question schema and ignores unrelated tools", () => {
    const input = { questions: [{ question: "选哪一个？", options: [{ label: "A", description: "说明" }, { label: "B" }] }] };
    expect(parseQuestionTool("request_user_input", input)).toEqual([{ title: "选哪一个？", options: ["A", "B"] }]);
    expect(parseQuestionTool("exec", input)).toBeNull();
    expect(parseQuestionTool("request_user_input_async", "{broken")).toBeNull();
  });
});
