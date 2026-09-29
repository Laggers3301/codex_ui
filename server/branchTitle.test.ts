import { describe, expect, it } from "vitest";
import { branchTitle } from "./routes.js";

describe("branch title", () => {
  it("uses the target account's short name", () => {
    expect(branchTitle("name", "111111", "222222")).toBe("name - 1111");
  });

  it("replaces a previous account suffix instead of stacking them", () => {
    expect(branchTitle("name - 2222", "111111", "222222")).toBe("name - 1111");
    expect(branchTitle("name · 分支", "111111", "222222")).toBe("name - 1111");
  });

  it("preserves descriptive labels and leaves unpooled branches unnamed by account", () => {
    expect(branchTitle("name", "Account B", "Account A")).toBe("name - Account B");
    expect(branchTitle("name", null, null)).toBe("name");
  });
});
