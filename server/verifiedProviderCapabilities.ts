import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Ark 261017 standard vision verified against the configured Coding endpoint,
 * including a successful image OCR request on 2026-10-23. Do not infer that
 * every domestic model, alias or provider exposes the same capabilities.
 * Official reference: console.volcengine.com/ark/region:cn-beijing/docs/deepseek-v4-1-flash
 */
export function applyVerifiedProviderCapabilities(accountId: string, catalog: { models?: unknown[] }): boolean {
  if (accountId !== "ark-coding") return false;
  let changed = false;
  for (const value of catalog.models ?? []) {
    if (!value || typeof value !== "object") continue;
    const model = value as Record<string, unknown>;
    if (model.slug !== "deepseek-v4-1-flash-261017") continue;
    const modalities = Array.isArray(model.input_modalities) ? model.input_modalities : ["text"];
    if (!modalities.includes("image")) {
      model.input_modalities = [...modalities, "image"];
      changed = true;
    }
  }
  return changed;
}

/** Called only when constructing the replacement runtime, under existing
 * startup/idle-maintenance control. No running runtime is stopped here. */
export function prepareVerifiedProviderCatalog(codexHome: string, accountId: string): void {
  if (accountId !== "ark-coding") return;
  const file = path.join(codexHome, "model-catalog-gpt-5.6-sol-long-context.json");
  if (!fs.existsSync(file)) return;
  const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!applyVerifiedProviderCapabilities(accountId, catalog)) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
