import { describe, expect, it } from "vitest";
import { extractImageTargetsFromText, resolveRelativeAssetTarget } from "./subagentAssets";

describe("resolveRelativeAssetTarget", () => {
  it("anchors ordinary relative asset paths to the child cwd", () => {
    expect(resolveRelativeAssetTarget("/workspace/project", "decoded/idle.png")).toBe("/workspace/project/decoded/idle.png");
  });

  it("preserves query/hash suffixes and normalizes in-base dot segments", () => {
    expect(resolveRelativeAssetTarget("/workspace/project", "./assets/../decoded/waving.png?v=1#frame")).toBe("/workspace/project/decoded/waving.png?v=1#frame");
  });

  it("refuses absolute, URI, missing-base, or cwd-escaping targets", () => {
    expect(resolveRelativeAssetTarget("/workspace/project", "/decoded/idle.png")).toBeNull();
    expect(resolveRelativeAssetTarget("/workspace/project", "file:///tmp/image.png")).toBeNull();
    expect(resolveRelativeAssetTarget(undefined, "decoded/idle.png")).toBeNull();
    expect(resolveRelativeAssetTarget("/workspace/project", "../../outside.png")).toBeNull();
  });

  it("extracts complete path tokens without inventing absolute suffix paths", () => {
    const text = "图集 `20261003-nailong-v2/decoded/idle.png`；挥手 `decoded/waving.png`。绝对 `/absolute/path.png`。原图 ![source](/home/user/generated_images/base.png)，Markdown ![idle](decoded/idle.png)。链接 https://example.test/assets/remote.png (括号内 /workspace/中文图.png)";
    expect(extractImageTargetsFromText(text, true)).toEqual([
      "20261003-nailong-v2/decoded/idle.png",
      "decoded/waving.png",
      "/absolute/path.png",
      "/home/user/generated_images/base.png",
      "decoded/idle.png",
      "/workspace/中文图.png"
    ]);
  });

  it("does not extract relative paths without a cwd or URL path fragments", () => {
    expect(extractImageTargetsFromText("https://example.test/assets/remote.png decoded/waving.png", false)).toEqual([]);
  });

  it("never joins adjacent filenames quoted in the real repair report", () => {
    const report = "只找到“`decoded/idle.png`、`waving.png` 坏了”的描述。";
    expect(extractImageTargetsFromText(report, true)).toEqual(["decoded/idle.png", "waving.png"]);
    expect(extractImageTargetsFromText(report, false)).toEqual([]);
  });
});
