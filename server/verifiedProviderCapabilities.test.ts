import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyVerifiedProviderCapabilities, prepareVerifiedProviderCatalog } from "./verifiedProviderCapabilities.js";
import { validateModelRequest } from "./modelRequestValidation.js";

it("adds vision only to the verified Ark model and preserves other metadata", () => {
  const model = { slug: "deepseek-v4-1-flash-261017", input_modalities: ["text"], context_window: 1048576, tool_mode: "function_call" };
  const other = { slug: "deepseek-v4-flash", input_modalities: ["text"] };
  const catalog = { models: [model, other] };
  expect(applyVerifiedProviderCapabilities("mimo-plan", catalog)).toBe(false);
  expect(applyVerifiedProviderCapabilities("ark-coding", catalog)).toBe(true);
  expect(model).toEqual({ ...model, input_modalities: ["text", "image"] });
  expect(other.input_modalities).toEqual(["text"]);
  expect(applyVerifiedProviderCapabilities("ark-coding", catalog)).toBe(false);
});

it("atomically prepares the next runtime catalog and invalidates request validation cache", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verified-vision-"));
  const file = path.join(dir, "model-catalog-gpt-5.6-sol-long-context.json");
  const request = { model: "deepseek-v4-1-flash-261017", input: [{ type: "localImage", path: "/fixture.png" }] };
  try {
    fs.writeFileSync(file, JSON.stringify({ models: [{ slug: request.model, input_modalities: ["text"] }] }));
    expect(() => validateModelRequest(dir, "turn/start", request)).toThrow("不支持图片");
    prepareVerifiedProviderCatalog(dir, "ark-coding");
    expect(() => validateModelRequest(dir, "turn/start", request)).not.toThrow();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const stamp = fs.statSync(file).mtimeMs;
    prepareVerifiedProviderCatalog(dir, "ark-coding");
    expect(fs.statSync(file).mtimeMs).toBe(stamp);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
