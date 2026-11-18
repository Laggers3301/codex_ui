import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { modelCatalogSource, readCatalogModels, accountModelSupportsUltrafast } from "./modelCatalogSource.js";
import { validateModelRequest } from "./modelRequestValidation.js";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-picker-")); roots.push(home);
  const legacy = path.join(home, "model-catalog-gpt-5.6-sol-long-context.json"), native = path.join(home, "models_cache.json");
  fs.writeFileSync(legacy, JSON.stringify({ models: [{ slug: "gpt-6.1-sol", visibility: "list" }] }));
  fs.writeFileSync(native, JSON.stringify({ models: [
    { slug: "gpt-6.2-sol", visibility: "list", additional_speed_tiers: ["fast", "ultrafast"] },
    { slug: "gpt-6.2-astra", visibility: "list", service_tiers: [{ id: "priority" }] }
  ] }));
  return { home, legacy, native };
}
it("reads native discovery for UI and validation without pinning or rewriting either catalog", () => {
  vi.stubEnv("CODEX_WEB_CODEX_MODEL_DISCOVERY", "native");
  const { home, legacy, native } = fixture(), before = fs.readFileSync(legacy, "utf8");
  expect(modelCatalogSource(home)).toBe(native);
  expect(readCatalogModels(native).map(m => m.slug)).toContain("gpt-6.2-sol");
  expect(accountModelSupportsUltrafast(home, "gpt-6.2-sol")).toBe(true);
  expect(() => validateModelRequest(home, "turn/start", { model: "gpt-6.2-sol", serviceTierForTurn: "ultrafast" })).not.toThrow();
  expect(() => validateModelRequest(home, "turn/start", { model: "gpt-6.2-astra", serviceTier: "ultrafast" })).toThrow("未开放");
  expect(() => validateModelRequest(home, "turn/start", { collaborationMode: { settings: { model: "gpt-6.2-astra" } }, serviceTierForTurn: "ultrafast" })).toThrow("未开放");
  expect(fs.readFileSync(legacy, "utf8")).toBe(before);
  fs.writeFileSync(native, "{broken"); expect(modelCatalogSource(home)).toBe(legacy);
});
it("keeps API providers and explicit legacy discovery on their own catalog", () => {
  const { home, legacy } = fixture();
  fs.writeFileSync(path.join(home, "config.toml"), 'model_provider = "fixture-provider"\n');
  expect(modelCatalogSource(home)).toBe(legacy);
  fs.writeFileSync(path.join(home, "config.toml"), "");
  vi.stubEnv("CODEX_WEB_CODEX_MODEL_DISCOVERY", "legacy"); expect(modelCatalogSource(home)).toBe(legacy);
});
