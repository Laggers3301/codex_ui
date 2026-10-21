import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateModelRequest as validate } from "./modelRequestValidation.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(model: object) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-capabilities-")); roots.push(root);
  fs.writeFileSync(path.join(root, "model-catalog-gpt-5.6-sol-long-context.json"), JSON.stringify({ models: [{ slug: "test", ...model }] }));
  return root;
}
it("blocks explicitly unsupported images/effort before transport, never drops input", () => {
  const home = fixture({ input_modalities: ["text"], supported_reasoning_levels: [{ effort: "low" }] });
  const p = { model: "test", input: [{ type: "localImage", path: "/image" }] };
  expect(() => validate(home, "turn/start", p)).toThrow("不支持图片");
  expect(p.input).toHaveLength(1);
  expect(() => validate(home, "turn/start", { model: "test", effort: "ultra" })).toThrow("不支持推理档位");
  expect(() => validate(home, "turn/start", { model: "test", effort: "low", input: [{ type: "text", text: "normal" }] })).not.toThrow();
});
it("permits declared images and unknown capabilities; leaves maintenance RPCs alone", () => {
  const home = fixture({ input_modalities: ["text", "image"] });
  const p = { model: "test", input: [{ type: "image", url: "data:image/png;base64,fixture" }] };
  expect(() => validate(home, "turn/start", p)).not.toThrow();
  expect(() => validate(home, "account/read", { ...p, outputSchema: "bad" })).not.toThrow();
  expect(() => validate(home, "turn/start", { model: "unknown", effort: "ultra" })).not.toThrow();
});
it("rejects malformed/explicitly unsupported structured output without claiming full schema validation", () => {
  const home = fixture({ supports_structured_outputs: false });
  expect(() => validate(home, "turn/start", { model: "test", outputSchema: {} })).toThrow("不支持结构化输出");
  const other = fixture({});
  expect(() => validate(other, "turn/start", { model: "test", outputSchema: "json" })).toThrow("JSON Schema 对象");
  expect(() => validate(other, "turn/start", { model: "test", outputSchema: { type: "invalid" } })).toThrow("type 无效");
  expect(() => validate(other, "turn/start", { model: "test", outputSchema: { type: "object", properties: { result: { type: "string" } } } })).not.toThrow();
});
it("rejects tools only when explicitly unsupported and reloads changed catalogs", () => {
  const home = fixture({ supports_tools: false, supports_parallel_tool_calls: false });
  expect(() => validate(home, "thread/start", { model: "test", dynamicTools: [{ name: "test" }] })).toThrow("不支持工具调用");
  expect(() => validate(home, "turn/start", { model: "test", parallelToolCalls: true })).toThrow("不支持并行工具调用");
  const file = path.join(home, "model-catalog-gpt-5.6-sol-long-context.json");
  fs.writeFileSync(file, JSON.stringify({ models: [{ slug: "test", supports_tools: true, input_modalities: ["text", "image"] }] }));
  expect(() => validate(home, "thread/start", { model: "test", dynamicTools: [{ name: "test" }] })).not.toThrow();
  expect(() => validate(home, "turn/start", { model: "test", input: [{ type: "image" }] })).not.toThrow();
});
