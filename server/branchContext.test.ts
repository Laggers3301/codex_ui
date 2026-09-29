import { describe, expect, it } from "vitest";
import { isLegacyGeneratedBranchPin } from "./branchContext.js";

describe("legacy branch pins", () => {
  it("filters both generations of automatic summaries without removing manual pins", () => {
    expect(isLegacyGeneratedBranchPin("【原会话最初目标】\n旧内容")).toBe(true);
    expect(isLegacyGeneratedBranchPin("【用户固定上下文】\n【原会话最初目标】\n旧内容")).toBe(true);
    expect(isLegacyGeneratedBranchPin("项目目标：保留这个人工固定内容")).toBe(false);
  });
});
