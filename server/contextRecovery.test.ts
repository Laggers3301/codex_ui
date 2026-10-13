import { describe, expect, it } from "vitest";
import {
  continuationRecoveryPrompt,
  contextRecoveryMessagePrefix,
  contextRecoveryPrompt,
  isContextCompactionItem,
  isGenericContextLossReply,
  isPlanOnlyContinuationReply,
  isPotentialGenericContextLossReply
} from "./contextRecovery.js";

describe("context-window recovery guard", () => {
  it("recognizes the durable compaction item emitted after new_context", () => {
    expect(isContextCompactionItem({ type: "toolCall", tool: "contextCompaction" })).toBe(true);
    expect(isContextCompactionItem({ type: "context_compaction" })).toBe(true);
    expect(isContextCompactionItem({ type: "toolCall", tool: "exec" })).toBe(false);
  });

  it("matches only generic lost-context replies and their streaming prefixes", () => {
    expect(isGenericContextLossReply("Ready—what would you like me to work on?")).toBe(true);
    expect(isGenericContextLossReply("What would you like me to work on?")).toBe(true);
    expect(isPotentialGenericContextLossReply("Ready—what would")).toBe(true);
    expect(isGenericContextLossReply("Ready to continue renaming PhysPosterior.")).toBe(false);
    expect(isPotentialGenericContextLossReply("Ready to continue renaming PhysPosterior.")).toBe(false);
  });

  it("requires checkpoint hydration before an answer", () => {
    const prompt = contextRecoveryPrompt();
    expect(prompt.startsWith(contextRecoveryMessagePrefix)).toBe(true);
    expect(prompt).toContain("notes tool");
    expect(prompt).toContain("Do not ask what to work on");
  });

  it("detects immediate action promises that ended without a tool call", () => {
    expect(isPlanOnlyContinuationReply("我现在去跑测试，确认构建结果。")).toBe(true);
    expect(isPlanOnlyContinuationReply("接下来我会检查这个边界并修复。")).toBe(true);
    expect(isPlanOnlyContinuationReply("I'll now run the tests and verify the build.")).toBe(true);
    expect(isPlanOnlyContinuationReply("我接下来改代码，马上跑测试。")).toBe(true);
    expect(isPlanOnlyContinuationReply("I am going to inspect the logs.")).toBe(true);
    expect(isPlanOnlyContinuationReply("我现在去运行 `npm test` 验证。")).toBe(true);
    expect(isPlanOnlyContinuationReply("我现在运行。")).toBe(true);
    expect(isPlanOnlyContinuationReply("我接下来改，改完马上跑测试和构建。")).toBe(true);
  });

  it("does not treat final summaries or user-gated plans as continuation replies", () => {
    expect(isPlanOnlyContinuationReply("任务已经完成，测试结果如下。")).toBe(false);
    expect(isPlanOnlyContinuationReply("接下来我会验证，但先等你确认。")).toBe(false);
    expect(isPlanOnlyContinuationReply("最终结论是这里不需要修改。")).toBe(false);
    expect(isPlanOnlyContinuationReply("I'll now run the tests, once you confirm.")).toBe(false);
  });

  it("does not recover complete recommendations like the C294 answer", () => {
    expect(isPlanOnlyContinuationReply("我的判断是：下一步应集中解决真实数据验收，而不是继续扩模型库。\n\n建议按下面顺序推进。\n\n你现在最值得承担的工作，是把 C294 做成可定位、可复测的案例，并验证一个局部 PP 修正是否真的降低独立标注误差。先得到一次可信的提升，再扩到更多场景。")).toBe(false);
    expect(isPlanOnlyContinuationReply("下一步先做一个无需训练的时序对照实验。\n\n同一权重运行三种模式，同时验证精度和实际延迟。")).toBe(false);
    expect(isPlanOnlyContinuationReply("接下来你可以检查日志，然后决定是否修改。")).toBe(false);
    expect(isPlanOnlyContinuationReply("我现在建议你先验证，而不是立即修改。")).toBe(false);
    expect(isPlanOnlyContinuationReply("模型说‘我现在去跑测试’，但没有执行工具。实际建议别用 MiMo 做长任务。")).toBe(false);
  });

  it("requires a terminal first-person promise, not a quote or an earlier plan", () => {
    expect(isPlanOnlyContinuationReply('```text\n我现在去跑测试。\n```')).toBe(false);
    expect(isPlanOnlyContinuationReply("> 我现在去跑测试。\n\n这是一个假完成示例。")).toBe(false);
    expect(isPlanOnlyContinuationReply("我现在去检查。\n\n检查发现内参不匹配，应优先修正投影流程。")).toBe(false);
    expect(isPlanOnlyContinuationReply("我现在去检查，是否允许？")).toBe(false);
    expect(isPlanOnlyContinuationReply("我现在不会去运行测试。")).toBe(false);
    expect(isPlanOnlyContinuationReply("我现在去检查。\n\n" + "已有详细分析。".repeat(110))).toBe(false);
  });

  it("provides a direct continuation prompt", () => {
    expect(continuationRecoveryPrompt()).toContain("perform that promised action");
    expect(continuationRecoveryPrompt()).toContain("Do not send another planning-only final response");
  });
});
