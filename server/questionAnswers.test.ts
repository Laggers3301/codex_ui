import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ProjectStore } from "./db.js";
import { questionAnswersForPage } from "./questionAnswers.js";

it("restores replies only for owned questions on the requested page", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "question-answer-display-"));
  const file = path.join(temp, "store.sqlite");
  let store = new ProjectStore(file);
  try {
    const project = store.createProject({ name: "test", rootPath: temp });
    store.registerThreadOwner({ threadId: "thread", userId: "admin", projectId: project.id, rootPath: temp });
    store.recordQuestionAnswer("thread", "native", "admin", { answers: { a: { answers: ["自定义回答"] } } });
    store.recordQuestionAnswer("thread", "async", "admin", ["A"]);
    store.close(); store = new ProjectStore(file);
    const question = (id: string) => ({ id, type: "toolCall", tool: "request_user_input", input: JSON.stringify({ questions: [{ id: "a", title: "问题" }] }) });
    const page = { turns: [{ items: [question("native"), { id: "async", type: "agentMessage", delivery: "async", questions: [{ title: "选择" }] }] }] };
    expect(questionAnswersForPage(store, "thread", "admin", page)).toEqual({ native: { answers: { a: { answers: ["自定义回答"] } } }, async: ["A"] });
    expect(questionAnswersForPage(store, "thread", "other", page)).toEqual({});
    expect(questionAnswersForPage(store, "thread", "admin", { turns: [{ items: [question("async")] }] })).toEqual({ async: ["A"] });
    expect(questionAnswersForPage(store, "thread", "admin", { turns: [{ items: [{ id: "native", type: "agentMessage", text: "无关正文" }] }] })).toEqual({});
  } finally { store.close(); fs.rmSync(temp, { recursive: true, force: true }); }
});
