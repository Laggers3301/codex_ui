import { describe, expect, it } from "vitest";
import {
  contextRecoveryMessagePrefix,
  contextRecoveryPrompt,
  isContextCompactionItem,
  isGenericContextLossReply,
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
});
