import fs, { type FileHandle } from "node:fs/promises";
import { findThreadJsonlPathById } from "./threadFallback.js";
import type { ThreadContextConfig, ThreadContextProfile, ThreadContextScope } from "./db.js";

export const contextWarningPercent = 80;
/**
 * Reversible master switch for per-thread context overrides and their UI.
 * Keep disabled by default so Codex follows its model-specific native tuning.
 * Set CODEX_THREAD_CONTEXT_FEATURE_ENABLED=true and restart the backend to
 * restore the existing feature without a code change or frontend rebuild.
 */
export const threadContextFeatureEnabled = process.env.CODEX_THREAD_CONTEXT_FEATURE_ENABLED === "true";
const contextStatusProbeBytes = 16 * 1024 * 1024;
const contextUsageCache = new Map<string, { filePath: string; size: number; mtimeMs: number; configKey: string; value: ThreadContextUsage }>();

export interface ThreadContextUsage {
  usedTokens: number | null;
  contextWindow: number | null;
  usedPercent: number | null;
  compactTokenLimit: number | null;
  effectiveCompactTokenLimit: number | null;
  compactAtPercent: number | null;
  warningPercent: number;
  lastTokenCountAt: string | null;
  compactedAt: string[];
}

export type ThreadContextConfigInput = {
  profile: ThreadContextProfile;
  contextWindow?: number | null;
  compactTokenLimit?: number | null;
  scope?: ThreadContextScope | null;
};

export class ThreadContextConfigError extends Error {}

export const defaultThreadContextConfig = (threadId: string): ThreadContextConfig => ({
  threadId,
  profile: "default",
  contextWindow: null,
  compactTokenLimit: null,
  scope: "total",
  updatedAt: null
});

/** Resolve named profiles server-side so a stale client cannot submit misleading values. */
export function resolveThreadContextConfig(threadId: string, input: ThreadContextConfigInput): ThreadContextConfig {
  const base = { threadId, updatedAt: null };
  if (input.profile === "default") {
    // Native default means omitting both knobs. This also clears any previous
    // per-thread override when the feature is enabled again.
    return { ...base, profile: "default", contextWindow: null, compactTokenLimit: null, scope: "total" };
  }
  if (input.profile === "balanced") {
    return { ...base, profile: "balanced", contextWindow: null, compactTokenLimit: 225_000, scope: "total" };
  }
  if (input.profile === "long") {
    return { ...base, profile: "long", contextWindow: 372_000, compactTokenLimit: 320_000, scope: "total" };
  }
  if (input.profile === "maximum") {
    return { ...base, profile: "maximum", contextWindow: 1_000_000, compactTokenLimit: 900_000, scope: "total" };
  }

  const contextWindow = input.contextWindow ?? null;
  const compactTokenLimit = input.compactTokenLimit ?? null;
  const scope = input.scope === "body_after_prefix" ? "body_after_prefix" : "total";
  if (!Number.isInteger(contextWindow) || contextWindow! < 64_000 || contextWindow! > 1_000_000) {
    throw new ThreadContextConfigError("自定义上下文窗口必须在 64,000 到 1,000,000 token 之间。");
  }
  if (!Number.isInteger(compactTokenLimit) || compactTokenLimit! < 32_000) {
    throw new ThreadContextConfigError("自定义 compact 阈值不能低于 32,000 token。");
  }
  if (compactTokenLimit! > Math.floor(contextWindow! * 0.9)) {
    throw new ThreadContextConfigError("compact 阈值最多为上下文窗口的 90%，需要给模型输出和工具结果留出空间。");
  }
  return { ...base, profile: "custom", contextWindow, compactTokenLimit, scope };
}

/** Shape consumed natively by app-server thread/start and thread/resume. */
export function threadContextConfigOverrides(
  config: ThreadContextConfig | null | undefined,
  lastObservedContextWindow?: number | null
): Record<string, unknown> {
  if (!threadContextFeatureEnabled || !config) return {};
  if (config.profile === "default" && config.contextWindow === null && config.compactTokenLimit === null) return {};
  const overrides: Record<string, unknown> = {};
  if (config.contextWindow !== null) overrides.model_context_window = config.contextWindow;
  if (config.compactTokenLimit !== null) {
    const observedSafeLimit = lastObservedContextWindow && lastObservedContextWindow > 0
      ? Math.floor(lastObservedContextWindow * 90 / 95)
      : config.compactTokenLimit;
    overrides.model_auto_compact_token_limit = Math.min(config.compactTokenLimit, observedSafeLimit);
  }
  overrides.model_auto_compact_token_limit_scope = config.scope;
  return overrides;
}

/** Shape consumed by the locally extended app-server turn/start method.
 *
 * Unlike thread/start and thread/resume, an explicit null is meaningful here:
 * it clears a previous sticky per-thread override and restores model defaults.
 */
export function threadTurnContextConfigOverrides(
  config: ThreadContextConfig | null | undefined,
  lastObservedContextWindow?: number | null
): Record<string, unknown> {
  if (!threadContextFeatureEnabled) {
    return {
      model_context_window: null,
      model_auto_compact_token_limit: null,
      model_auto_compact_token_limit_scope: "total"
    };
  }
  const nativeOverrides = threadContextConfigOverrides(config, lastObservedContextWindow);
  return {
    model_context_window: config?.contextWindow ?? null,
    model_auto_compact_token_limit: nativeOverrides.model_auto_compact_token_limit ?? null,
    model_auto_compact_token_limit_scope: config?.scope ?? "total"
  };
}

export function contextWindowMeasuredForConfig(
  config: ThreadContextConfig,
  usage: Pick<ThreadContextUsage, "contextWindow" | "lastTokenCountAt">
): number | null {
  if (!usage.contextWindow) return null;
  if (!config.updatedAt) return usage.contextWindow;
  if (!usage.lastTokenCountAt) return null;
  return Date.parse(usage.lastTokenCountAt) >= Date.parse(config.updatedAt) ? usage.contextWindow : null;
}

export function contextPinDeveloperInstructions(text: string): string | undefined {
  const retained = text.trim();
  if (!retained) return undefined;
  return [
    "The user explicitly pinned the following durable context for this Codex thread.",
    "Keep it available across history compaction. Treat it as background context, not as a new user request, and do not repeat it unless relevant.",
    "<pinned_thread_context>",
    retained,
    "</pinned_thread_context>"
  ].join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function isCompactionRecord(record: Record<string, unknown>): boolean {
  const payload = asRecord(record.payload);
  const type = String(record.type ?? "").toLowerCase();
  const payloadType = String(payload.type ?? "").toLowerCase();
  return type === "compacted"
    || type === "context_compacted"
    || payloadType === "context_compacted"
    || payloadType === "context_compaction";
}

/** Read only the JSONL tail. This keeps opening a long conversation cheap. */
export async function readThreadContextUsage(
  threadId: string,
  config: ThreadContextConfig = defaultThreadContextConfig(threadId)
): Promise<ThreadContextUsage> {
  const configKey = `${config.profile}:${config.contextWindow ?? "default"}:${config.compactTokenLimit ?? "default"}:${config.scope}`;
  const empty: ThreadContextUsage = {
    usedTokens: null,
    contextWindow: null,
    usedPercent: null,
    compactTokenLimit: config.compactTokenLimit,
    effectiveCompactTokenLimit: config.compactTokenLimit,
    compactAtPercent: null,
    warningPercent: contextWarningPercent,
    lastTokenCountAt: null,
    compactedAt: []
  };
  const filePath = await findThreadJsonlPathById(threadId);
  if (!filePath) return empty;

  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const cached = contextUsageCache.get(threadId);
    if (cached && cached.filePath === filePath && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.configKey === configKey) {
      return cached.value;
    }
    const size = Math.min(stat.size, contextStatusProbeBytes);
    if (!size) return empty;
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, Math.max(0, stat.size - size));
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    const compactedAt: string[] = [];
    let usedTokens: number | null = null;
    let contextWindow: number | null = null;
    let lastTokenCountAt: string | null = null;

    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // The first line can be partial when reading a tail window.
        continue;
      }
      const at = timestamp(record.timestamp);
      if (isCompactionRecord(record) && at) {
        compactedAt.push(at);
      }
      const payload = asRecord(record.payload);
      if (record.type !== "event_msg" || payload.type !== "token_count") continue;
      const info = asRecord(payload.info);
      const lastUsage = asRecord(info.last_token_usage);
      const nextUsedTokens = finiteNumber(lastUsage.total_tokens) ?? finiteNumber(lastUsage.input_tokens);
      const nextWindow = finiteNumber(info.model_context_window);
      if (nextUsedTokens !== null && nextWindow !== null && nextWindow > 0) {
        usedTokens = nextUsedTokens;
        contextWindow = nextWindow;
        lastTokenCountAt = at;
      }
    }

    const uniqueCompactions = [...new Set(compactedAt)].slice(-20);
    const latestCompactAt = uniqueCompactions.at(-1) ?? null;
    // A compact event newer than the latest token count invalidates the old
    // high-water reading. The next turn will provide a fresh active-context size.
    if (latestCompactAt && (!lastTokenCountAt || latestCompactAt > lastTokenCountAt)) {
      usedTokens = null;
      lastTokenCountAt = null;
    }
    const usedPercent = usedTokens !== null && contextWindow
      ? Math.min(100, Math.max(0, (usedTokens / contextWindow) * 100))
      : null;
    const measurementAppliesToConfig = !config.updatedAt
      || Boolean(lastTokenCountAt && Date.parse(lastTokenCountAt) >= Date.parse(config.updatedAt));
    const safetyContextWindow = measurementAppliesToConfig ? contextWindow : null;
    const effectiveCompactTokenLimit = config.compactTokenLimit !== null && safetyContextWindow
      ? Math.min(config.compactTokenLimit, Math.floor(safetyContextWindow * 90 / 95))
      : config.compactTokenLimit;
    const value: ThreadContextUsage = {
      usedTokens,
      contextWindow,
      usedPercent,
      compactTokenLimit: config.compactTokenLimit,
      effectiveCompactTokenLimit,
      compactAtPercent: contextWindow && effectiveCompactTokenLimit
        ? Math.min(100, (effectiveCompactTokenLimit / contextWindow) * 100)
        : null,
      warningPercent: contextWarningPercent,
      lastTokenCountAt,
      compactedAt: uniqueCompactions
    };
    contextUsageCache.set(threadId, { filePath, size: stat.size, mtimeMs: stat.mtimeMs, configKey, value });
    return value;
  } catch {
    return empty;
  } finally {
    await handle?.close();
  }
}
