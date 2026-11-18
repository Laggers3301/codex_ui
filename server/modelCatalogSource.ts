import fs from "node:fs";
import path from "node:path";
import { nativeModelDiscoveryEnabled } from "./nativeModelDiscovery.js";

type Model = Record<string, unknown>;
const cache = new Map<string, { stamp: number; size: number; models: Model[] }>();

export function readCatalogModels(file: string): Model[] {
  const stat = fs.statSync(file);
  if (stat.size > 2 * 1024 * 1024) throw new Error("Model catalog exceeds byte budget");
  const previous = cache.get(file);
  if (previous?.stamp === stat.mtimeMs && previous.size === stat.size) return previous.models;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(data.models) || !data.models.length) throw new Error("Empty model catalog");
  const models = data.models.filter((m: unknown): m is Model => Boolean(m) && typeof m === "object" && !Array.isArray(m));
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(file, { stamp: stat.mtimeMs, size: stat.size, models });
  return models;
}

/** Native discovery owns this cache. Never pin its runtime to the legacy UI file. */
export function modelCatalogSource(home: string): string {
  const native = path.join(home, "models_cache.json");
  if (nativeModelDiscoveryEnabled(home)) {
    try { if (readCatalogModels(native).some(m => m.visibility === "list")) return native; }
    catch { /* Keep the last installed UI catalog while native discovery starts. */ }
  }
  return path.join(home, "model-catalog-gpt-5.6-sol-long-context.json");
}

export function accountModelSupportsUltrafast(home: string, model: string): boolean {
  try {
    const entry = readCatalogModels(modelCatalogSource(home)).find(m => m.slug === model && m.visibility === "list");
    return Array.isArray(entry?.additional_speed_tiers) && entry.additional_speed_tiers.includes("ultrafast")
      || Array.isArray(entry?.service_tiers) && entry.service_tiers.some(t => t?.id === "ultrafast");
  } catch { return false; }
}
