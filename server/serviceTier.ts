/** Missing means an older client: preserve the runtime's saved preference. */
export function requestedServiceTier(value: unknown): { serviceTier?: "fast" | null } {
  if (value === undefined) return {};
  if (value === "fast" || value === null) return { serviceTier: value };
  throw new Error("Invalid serviceTier: expected fast or null.");
}

export function requestedTurnServiceTier(value: unknown) {
  const tier = requestedServiceTier(value);
  return value === undefined ? tier : {
    ...tier,
    // Explicitly override an account/thread default, including Fast Off.
    serviceTierForTurn: value === "fast" ? "priority" : "default"
  };
}
