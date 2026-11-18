import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ModelCatalogAutoUpdater } from "./modelCatalogAutoUpdate.js";
import { serverConfig } from "./config.js";
import type { AccountPoolBridge } from "./accountPoolBridge.js";

it("monitors native model, effort and speed changes and notifies clients without runtime/auth requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-sync-")), oldDir = serverConfig.dataDir;
  const file = path.join(root, "models_cache.json"), emit = vi.fn(), applied = vi.fn();
  const write = (extra: object) => fs.writeFileSync(file, JSON.stringify({ models: [{ slug: "gpt-6.2-sol", visibility: "list", ...extra }] }));
  const pool = { uiModelCatalogTargets: () => [{ id: "fixture", codexHome: root, catalogPath: file }], automaticModelCatalogTargets: () => [], emit };
  serverConfig.dataDir = root;
  const updater = new ModelCatalogAutoUpdater(pool as unknown as AccountPoolBridge, 3600000, { info: vi.fn(), warn: vi.fn() }, applied);
  const tick = () => (updater as unknown as { tick(): Promise<void> }).tick();
  try {
    write({ additional_speed_tiers: ["fast"], supported_reasoning_levels: [{ effort: "low" }] });
    await tick(); await tick();
    expect(emit).toHaveBeenCalledTimes(1); expect(applied).toHaveBeenCalledTimes(1);
    write({ additional_speed_tiers: ["fast", "ultrafast"], supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] });
    await tick();
    expect(emit).toHaveBeenCalledTimes(2); expect(emit.mock.calls[1][0]).toBe("modelCatalogUpdated");
    const status = JSON.parse(fs.readFileSync(path.join(root, "native-model-catalog-sync.json"), "utf8"));
    expect(status.accounts[0].models[0].speedTiers).toEqual(["fast", "ultrafast"]);
    expect(status.accounts[0].models[0].reasoningLevels).toHaveLength(2);
  } finally { updater.stop(); serverConfig.dataDir = oldDir; fs.rmSync(root, { recursive: true, force: true }); }
});
