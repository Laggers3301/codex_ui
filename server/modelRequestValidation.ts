import fs from "node:fs";
import { AppError } from "./appErrors.js";
import { modelCatalogSource, accountModelSupportsUltrafast } from "./modelCatalogSource.js";
import { assertServiceTierEnabled } from "./serviceTier.js";
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const catalogs = new Map<string, { stamp: number; size: number; models: Record<string, unknown>[] }>();

/** Validate only explicitly declared capabilities. Unknown metadata is not a
 * reason to deny a working model. Never silently drop images/schema/effort. */
export function validateModelRequest(home: string, method: string, value: unknown): void {
  const p = record(value);
  assertServiceTierEnabled(p.serviceTier, p.serviceTierForTurn);
  if (!["turn/start", "thread/start", "thread/queue/add", "thread/queue/start"].includes(method)) return;
  const modelId = p.model ?? record(record(p.collaborationMode).settings).model;
  if (typeof modelId !== "string") return;
  if ((p.serviceTier === "ultrafast" || p.serviceTierForTurn === "ultrafast") && !accountModelSupportsUltrafast(home, modelId)) {
    throw new AppError("unsupported_model_capability", `当前账号未开放 ${modelId} 的 Ultra Fast，请选择标准或 Fast。`);
  }
  const file = modelCatalogSource(home);
  let models: Record<string, unknown>[];
  try {
    const stat = fs.statSync(file), cached = catalogs.get(file);
    if (cached && cached.stamp === stat.mtimeMs && cached.size === stat.size) models = cached.models;
    else {
      const catalog = record(JSON.parse(fs.readFileSync(file, "utf8")));
      models = Array.isArray(catalog.models) ? catalog.models.map(record) : [];
      if (catalogs.size >= 32) catalogs.delete(catalogs.keys().next().value!);
      catalogs.set(file, { stamp: stat.mtimeMs, size: stat.size, models });
    }
  } catch { return; }
  const model = models.find(m => m.slug === modelId);
  if (!model) return;
  const deny = (message: string): never => { throw new AppError("unsupported_model_capability", message); };
  const modalities = Array.isArray(model.input_modalities) ? model.input_modalities : null;
  for (const input of Array.isArray(p.input) ? p.input : []) {
    const kind = record(input).type;
    if ((kind === "image" || kind === "localImage") && modalities?.length && !modalities.includes("image")) deny(`${p.model} 当前不支持图片输入，请选择支持图片的模型。`);
  }
  const effort = p.effort ?? record(record(p.collaborationMode).settings).reasoning_effort;
  const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.map(x => record(x).effort).filter(x => typeof x === "string") : [];
  if (effort != null && levels.length && (typeof effort !== "string" || !levels.includes(effort))) deny(`${p.model} 不支持推理档位 ${String(effort)}，请重新选择。`);
  if ((Array.isArray(p.dynamicTools) && p.dynamicTools.length || Array.isArray(p.tools) && p.tools.length) && model.supports_tools === false) deny(`${p.model} 当前不支持工具调用。`);
  if (p.parallelToolCalls === true && model.supports_parallel_tool_calls === false) deny(`${p.model} 当前不支持并行工具调用。`);
  if (p.outputSchema != null) {
    if (!p.outputSchema || typeof p.outputSchema !== "object" || Array.isArray(p.outputSchema)) deny("结构化输出必须提供 JSON Schema 对象。");
    if (model.supports_structured_outputs === false) deny(`${p.model} 当前不支持结构化输出。`);
    // Validate the JSON transport shape, not a pretend full JSON-Schema engine.
    const schema = record(p.outputSchema);
    if (schema.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(schema.type)) && !Array.isArray(schema.type)) deny("结构化输出 Schema 的 type 无效。");
  }
}
