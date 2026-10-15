import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { responsesCompatibleModelCatalog } from "./modelCatalogCompatibility.js";
import { accountAppServerArgs } from "./accountPoolBridge.js";

const directories: string[] = [];
function fixture(catalog: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-catalog-compat-"));
  directories.push(directory);
  const file = path.join(directory, "model-catalog-gpt-5.6-sol-long-context.json");
  fs.writeFileSync(file, JSON.stringify(catalog));
  return { directory, file };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("gpt-6.1-sol Responses compatibility", () => {
  it("changes exactly one model field and leaves the source untouched", () => {
    const original = { metadata: { version: 1 }, models: [
      { slug: "gpt-6.1-sol", use_responses_lite: true, comp_hash: "3000", tool_mode: "code_mode_only", model_messages: { persistent_instructions: "preserve" } },
      { slug: "gpt-6-sol", use_responses_lite: true }
    ] };
    const { file, directory } = fixture(original);
    const before = fs.readFileSync(file, "utf8");
    const compatible = responsesCompatibleModelCatalog(file);
    const expected = structuredClone(original);
    expected.models[0].use_responses_lite = false;
    expect(JSON.parse(fs.readFileSync(compatible, "utf8"))).toEqual(expected);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(compatible).mode & 0o777).toBe(0o600);
    expect(accountAppServerArgs(directory)).toContain(`model_catalog_json=${JSON.stringify(compatible)}`);
  });
  it("regenerates compatibility from a refreshed source catalog", () => {
    const { file } = fixture({ models: [{ slug: "gpt-6.1-sol", use_responses_lite: true, revision: 1 }] });
    const compatible = responsesCompatibleModelCatalog(file);
    const firstMtime = fs.statSync(compatible).mtimeMs;
    expect(responsesCompatibleModelCatalog(file)).toBe(compatible);
    expect(fs.statSync(compatible).mtimeMs).toBe(firstMtime);
    fs.writeFileSync(file, JSON.stringify({ models: [{ slug: "gpt-6.1-sol", use_responses_lite: true, revision: 2 }] }));
    expect(responsesCompatibleModelCatalog(file)).toBe(compatible);
    expect(JSON.parse(fs.readFileSync(compatible, "utf8")).models[0]).toEqual({ slug: "gpt-6.1-sol", use_responses_lite: false, revision: 2 });
  });
  it.each([{ models: [] }, { models: [{ slug: "gpt-6.1-sol", use_responses_lite: false }] }, { models: [{ slug: "other", use_responses_lite: true }] }])("does not derive an unaffected catalog", catalog => {
    const { file } = fixture(catalog);
    expect(responsesCompatibleModelCatalog(file)).toBe(file);
    expect(fs.existsSync(`${file}.responses-compatible.json`)).toBe(false);
  });
  it("supports explicit rollback without modifying either catalog", () => {
    const { file } = fixture({ models: [{ slug: "gpt-6.1-sol", use_responses_lite: true }] });
    vi.stubEnv("CODEX_WEB_GPT61_RESPONSES_LITE_COMPAT", "0");
    expect(responsesCompatibleModelCatalog(file)).toBe(file);
    expect(fs.existsSync(`${file}.responses-compatible.json`)).toBe(false);
  });
});
