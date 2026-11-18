import { AppError } from "./appErrors.js";

export function ultrafastDisabled(): boolean {
  return process.env.CODEX_WEB_DISABLE_ULTRAFAST === "1";
}

export function assertServiceTierEnabled(...values: unknown[]): void {
  if (ultrafastDisabled() && values.includes("ultrafast")) {
    throw new AppError("unsupported_model_capability", "本服务已停用超快（Ultrafast），请选择标准或 Fast。");
  }
}

/** Missing means an older client: preserve the runtime's saved preference. */
export function requestedServiceTier(value: unknown): { serviceTier?: "fast" | "ultrafast" | null } {
  assertServiceTierEnabled(value);
  if (value === undefined) return {};
  if (value === "fast" || value === "ultrafast" || value === null) return { serviceTier: value };
  throw new Error("Invalid serviceTier: expected fast, ultrafast or null.");
}

export function requestedTurnServiceTier(value: unknown) {
  const tier = requestedServiceTier(value);
  return value === undefined ? tier : {
    ...tier,
    // Explicitly override an account/thread default, including Fast Off.
    serviceTierForTurn: value === "ultrafast" ? "ultrafast" : value === "fast" ? "priority" : "default"
  };
}
