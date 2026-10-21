const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (...values: unknown[]): number | undefined => values.find((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
export interface ProviderUsage {
  inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
  outputTokens: number; reasoningOutputTokens: number; totalTokens: number;
}
/** Canonical counts include cached input in input, and reasoning in output.
 * These subsets must not be added again to total or converted to quota %. */
export function normalizeProviderUsage(value: unknown): ProviderUsage {
  const u = record(value), inputDetails = record(u.input_tokens_details ?? u.prompt_tokens_details);
  const outputDetails = record(u.output_tokens_details ?? u.completion_tokens_details);
  const cached = count(u.cachedInputTokens, u.cached_input_tokens, u.prompt_cache_hit_tokens, u.cache_read_input_tokens, inputDetails.cached_tokens) ?? 0;
  const write = count(u.cacheWriteInputTokens, u.cache_write_input_tokens, u.cache_creation_input_tokens) ?? 0;
  const rawInput = count(u.inputTokens, u.input_tokens, u.prompt_tokens);
  const anthropic = u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined;
  const input = (rawInput ?? 0) + (anthropic ? cached + write : 0);
  const output = count(u.outputTokens, u.output_tokens, u.completion_tokens) ?? 0;
  const reasoning = count(u.reasoningOutputTokens, u.reasoning_output_tokens, u.reasoning_tokens, outputDetails.reasoning_tokens) ?? 0;
  return { inputTokens: input, cachedInputTokens: Math.min(cached, input), cacheWriteInputTokens: Math.min(write, Math.max(0, input - Math.min(cached, input))),
    outputTokens: output, reasoningOutputTokens: Math.min(reasoning, output),
    totalTokens: count(u.totalTokens, u.total_tokens) ?? input + output };
}

/** Native telemetry may send only cumulative totals. Bill their increment,
 * not the entire session repeatedly. Identical cumulative snapshots are not
 * new work; equal last-usage values without totals may be distinct requests. */
export class ProviderUsageTracker {
  private previous: ProviderUsage | undefined;
  consume(value: unknown): ProviderUsage | null {
    const info = record(value), last = record(info.last_token_usage ?? info.lastTokenUsage);
    const cumulative = record(info.total_token_usage ?? info.totalTokenUsage);
    const total = Object.keys(cumulative).length ? normalizeProviderUsage(cumulative) : undefined;
    const previous = this.previous;
    if (total) this.previous = total;
    if (total && previous && JSON.stringify(total) === JSON.stringify(previous)) return null;
    if (Object.keys(last).length) return normalizeProviderUsage(last);
    if (!total) return null;
    if (!previous || total.totalTokens < previous.totalTokens) return total;
    return Object.fromEntries(Object.entries(total).map(([key, n]) => [key, Math.max(0, n - previous[key as keyof ProviderUsage])])) as unknown as ProviderUsage;
  }
}
