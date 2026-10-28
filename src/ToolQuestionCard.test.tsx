// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("./api", () => ({ getApiUserId: () => "fixture" }));
vi.mock("./AccountUpdateIndicator", () => ({ AccountUpdateIndicator: () => null }));
import { ToolQuestionMessage } from "./ToolQuestionCard";

it("keeps an answered choice and free text in a user bubble, not an active question card", () => {
  const html = renderToStaticMarkup(<ToolQuestionMessage open={false}
    questions={[{ title: "选择机器人", options: ["A"] }, { title: "补充说明", options: [] }]}
    answers={["A", "自定义回答"]} onChoose={async () => false} />);
  expect(html).toContain('kind-user');
  expect(html).toContain('questionAnswerQuote');
  expect(html).toContain('questionAnswerValue');
  expect(html).toContain('自定义回答');
  expect(html).not.toContain('toolQuestionCard');
  expect(html).toContain('复制回答');
});

it("does not invent a reply from a completed tool alone", () => {
  const html = renderToStaticMarkup(<ToolQuestionMessage open={false}
    questions={[{ title: "选择机器人", options: ["A"] }]} onChoose={async () => false} />);
  expect(html).not.toContain('questionAnswerMessage');
});
