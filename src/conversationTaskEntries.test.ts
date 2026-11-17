import { expect, it } from "vitest";
import { conversationTaskEntries } from "./conversationTaskEntries";

it("combines one native agent with its transcript and keeps background commands separate", () => {
  const entries = conversationTaskEntries([{ id: "agent-a", name: "旧说明", state: "running", model: "Sonnet" }], [
    { id: "agent-a", kind: "agent", description: "检查接口", status: "completed", background: true, summary: "已完成检查" },
    { id: "shell-b", kind: "shell", description: "运行测试", status: "running", background: true },
  ]);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ id: "shell-b", state: "running", kind: "shell" });
  expect(entries[1]).toMatchObject({ id: "agent-a", name: "检查接口", state: "completed", model: "Sonnet", summary: "已完成检查" });
});

it("uses the directory identity for older task records without a kind and keeps unknown state distinct", () => {
  expect(conversationTaskEntries([{ id: "agent-a", name: "检查接口", state: "running" }], [
    { id: "agent-a", kind: "unknown", description: "", status: "unknown", background: false },
  ])).toMatchObject([{ id: "agent-a", kind: "agent", name: "检查接口", state: "unknown" }]);
});
