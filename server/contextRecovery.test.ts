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
  });

  it("does not treat final summaries or user-gated plans as continuation replies", () => {
    expect(isPlanOnlyContinuationReply("任务已经完成，测试结果如下。")).toBe(false);
    expect(isPlanOnlyContinuationReply("接下来我会验证，但先等你确认。")).toBe(false);
    expect(isPlanOnlyContinuationReply("最终结论是这里不需要修改。")).toBe(false);
  });

  it("provides a direct continuation prompt", () => {
    expect(continuationRecoveryPrompt()).toContain("perform that promised action");
    expect(continuationRecoveryPrompt()).toContain("Do not send another planning-only final response");
  });
});
