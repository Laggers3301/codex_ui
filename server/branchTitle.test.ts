import { describe, expect, it } from "vitest";
import { branchTitle } from "./routes.js";

describe("branch title", () => {
  it("uses the target account's short name", () => {
    expect(branchTitle("name", "100001", "100003")).toBe("name - 0001");
  });

  it("replaces a previous account suffix instead of stacking them", () => {
    expect(branchTitle("name - 0003", "100001", "100003")).toBe("name - 0001");
    expect(branchTitle("name · 分支", "100001", "100003")).toBe("name - 0001");
  });

  it("preserves descriptive labels and leaves unpooled branches unnamed by account", () => {
    expect(branchTitle("name", "Account B", "Account A")).toBe("name - Account B");
    expect(branchTitle("name", null, null)).toBe("name");
  });
});
