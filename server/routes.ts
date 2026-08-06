import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CodexBridge } from "./codexBridge.js";
import { authenticatedUserFromHeaders } from "./auth.js";
import { defaults, serverConfig } from "./config.js";
import { DEFAULT_USER_ID, type ProjectStore } from "./db.js";
import { listBrowsableDirectories } from "./directoryBrowser.js";
import { ensureProjectDirectory, PathPolicyError, resolveProjectFilePath, resolveProjectPath } from "./pathPolicy.js";
import { findThreadJsonlPathById, paginateThreadPayload, readThreadFromJsonl, readThreadSummaryFromJsonl, threadJsonlMatchesSearch, threadJsonlPathFromError } from "./threadFallback.js";
import { listAllCodexThreads, THREAD_LIST_PAGE_SIZE } from "./threadList.js";

const execFileAsync = promisify(execFile);
const uploadRoot = process.env.CODEX_WEB_UPLOAD_TMP_DIR ?? "/tmp/codex_remote_uploads";
// Default Codex cwd per logged-in user. Keep it inside the selected project
// root unless an operator explicitly configures a different workspace root.
const userWorkspaceRoot = process.env.CODEX_WEB_USER_WORKSPACE_ROOT ?? path.join(serverConfig.projectRoot, "users");
const maxPreviewBytes = 2 * 1024 * 1024;
const defaultThreadHistoryPageSize = 120;
const maxThreadHistoryPageSize = 240;

const textExtensions = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);
const markdownExtensions = new Set([".md", ".markdown", ".mdx"]);
const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mdx": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".toml": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8"
};

const sandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const approvalSchema = z.enum(["untrusted", "on-request", "never"]);
const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
type ReasoningEffort = z.infer<typeof effortSchema>;

const createProjectSchema = z.object({
  name: z.string().min(1),
  rootPath: z.string().min(1),
  createDirectory: z.boolean().optional(),
  gitInit: z.boolean().optional(),
  defaultModel: z.string().optional(),
  defaultReasoningEffort: effortSchema.optional(),
  defaultSandbox: sandboxSchema.optional(),
  defaultApprovalPolicy: approvalSchema.optional()
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  defaultModel: z.string().optional(),
  defaultReasoningEffort: effortSchema.optional(),
  defaultSandbox: sandboxSchema.optional(),
  defaultApprovalPolicy: approvalSchema.optional()
});

const createUserSchema = z.object({
  name: z.string().min(1)
});

const localSendSettingsSchema = z.object({
  sshHost: z.string().max(255).optional(),
  sshPort: z.coerce.number().int().min(1).max(65535).optional(),
  sshUser: z.string().max(128).optional(),
  destinationPath: z.string().max(2048).optional(),
  identityFile: z.string().max(2048).optional(),
  outputPath: z.string().max(2048).optional()
}).strict();

const sendLocalFileSchema = z.object({
  path: z.string().min(1),
  destinationPath: z.string().max(2048).optional()
});

const threadExportSchema = z.object({
  format: z.enum(["markdown", "json"]).optional().default("markdown"),
  sendLocal: z.boolean().optional().default(false),
  outputPath: z.string().max(2048).optional(),
  destinationPath: z.string().max(2048).optional()
});

const threadReadQuerySchema = z.object({
  projectId: z.string().optional(),
  before: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(maxThreadHistoryPageSize).optional().default(defaultThreadHistoryPageSize)
});

const fallbackCodexModels: Array<{
  slug: string;
  displayName: string;
  priority: number;
  efforts: ReasoningEffort[];
}> = [
  { slug: "gpt-5.5", displayName: "GPT-5.5", priority: 0, efforts: ["xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", priority: 1, efforts: ["ultra", "max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", priority: 2, efforts: ["ultra", "max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", priority: 3, efforts: ["max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.4", displayName: "GPT-5.4", priority: 16, efforts: ["xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", priority: 23, efforts: ["xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", priority: 26, efforts: ["xhigh", "high", "medium", "low"] }
];

const effortLabels: Record<ReasoningEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra"
};

const effortOrder: Record<ReasoningEffort, number> = {
  ultra: 0,
  max: 1,
  xhigh: 2,
  high: 3,
  medium: 4,
  low: 5
};

export type PublicModelProfile = {
  id: string;
  label: string;
  model: string;
  effort: ReasoningEffort;
  displayName: string;
  priority: number;
};

let modelCatalogCache: { expiresAt: number; data: PublicModelProfile[] } | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra";
}

function profilesForModel(model: { slug: string; displayName: string; priority: number }, efforts: ReasoningEffort[]): PublicModelProfile[] {
  return efforts.map((effort) => ({
    id: `${model.slug}:${effort}`,
    label: `${model.displayName} ${effortLabels[effort]}`,
    model: model.slug,
    effort,
    displayName: model.displayName,
    priority: model.priority
  }));
}

function fallbackModelProfiles(): PublicModelProfile[] {
  return fallbackCodexModels.flatMap((model) => profilesForModel(model, model.efforts));
}

function modelProfilesFromCatalog(catalog: unknown): PublicModelProfile[] {
  const models = Array.isArray(asRecord(catalog).models) ? (asRecord(catalog).models as unknown[]) : [];
  const profiles = models.flatMap((entry) => {
    const record = asRecord(entry);
    const slug = typeof record.slug === "string" ? record.slug.trim() : "";
    const displayName = typeof record.display_name === "string" ? record.display_name.trim() : slug;
    const visibility = typeof record.visibility === "string" ? record.visibility : "";
    const shellType = typeof record.shell_type === "string" ? record.shell_type : "";
    const priority = typeof record.priority === "number" ? record.priority : 999;
    if (!slug || visibility !== "list" || shellType !== "shell_command") {
      return [];
    }

    const rawLevels = Array.isArray(record.supported_reasoning_levels) ? record.supported_reasoning_levels : [];
    const efforts = rawLevels
      .map((level) => asRecord(level).effort)
      .filter(isReasoningEffort);
    const uniqueEfforts = Array.from(new Set(efforts.length ? efforts : [defaults.reasoningEffort]));
    return profilesForModel({ slug, displayName, priority }, uniqueEfforts);
  });

  return profiles.sort((left, right) => left.priority - right.priority || effortOrder[left.effort] - effortOrder[right.effort] || left.label.localeCompare(right.label));
}

function listModelProfiles(): PublicModelProfile[] {
  const now = Date.now();
  if (modelCatalogCache && modelCatalogCache.expiresAt > now) {
    return modelCatalogCache.data;
  }

  try {
    const stdout = execFileSync(serverConfig.codexBin, ["debug", "models"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env
    });
    const profiles = modelProfilesFromCatalog(JSON.parse(stdout));
    modelCatalogCache = { expiresAt: now + 5 * 60 * 1000, data: profiles.length ? profiles : fallbackModelProfiles() };
  } catch {
    modelCatalogCache = { expiresAt: now + 60 * 1000, data: fallbackModelProfiles() };
  }
  return modelCatalogCache.data;
}

type PublicRateLimitWindow = {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type PublicRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: PublicRateLimitWindow | null;
  secondary: PublicRateLimitWindow | null;
  credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
  individualLimit: { limit: string | null; used: string | null; remainingPercent: number | null; resetsAt: number | null } | null;
  planType: string | null;
  rateLimitReachedType: string | null;
};

type PublicCodexQuota = {
  account: { type: string | null; planType: string | null } | null;
  rateLimits: PublicRateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, PublicRateLimitSnapshot>;
  resetCredits: { availableCount: number | null } | null;
  usage: {
    summary: {
      lifetimeTokens: number | null;
      peakDailyTokens: number | null;
      longestRunningTurnSec: number | null;
      currentStreakDays: number | null;
      longestStreakDays: number | null;
    } | null;
    dailyUsageBuckets: Array<{ startDate: string; tokens: number | null }>;
  } | null;
  errors: string[];
  updatedAt: string;
};

// All Web users share the same locally logged-in Codex account.  Polling quota
// from every browser without a short shared cache would create redundant MCP
// requests and can itself make the quota display slow or unreliable.
const codexQuotaCacheTtlMs = 10_000;
let codexQuotaCache: { data: PublicCodexQuota; expiresAt: number } | null = null;
let codexQuotaRefreshInFlight: Promise<PublicCodexQuota> | null = null;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function safeCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function sanitizeRateLimitWindow(value: unknown): PublicRateLimitWindow | null {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    return null;
  }
  return {
    usedPercent: numberOrNull(record.usedPercent),
    windowDurationMins: numberOrNull(record.windowDurationMins),
    resetsAt: numberOrNull(record.resetsAt)
  };
}

function sanitizeRateLimitSnapshot(value: unknown): PublicRateLimitSnapshot | null {
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    return null;
  }
  const credits = asRecord(record.credits);
  const individualLimit = asRecord(record.individualLimit);
  return {
    limitId: stringOrNull(record.limitId),
    limitName: stringOrNull(record.limitName),
    primary: sanitizeRateLimitWindow(record.primary),
    secondary: sanitizeRateLimitWindow(record.secondary),
    credits: Object.keys(credits).length
      ? {
          hasCredits: booleanOrNull(credits.hasCredits),
          unlimited: booleanOrNull(credits.unlimited),
          balance: stringOrNull(credits.balance)
        }
      : null,
    individualLimit: Object.keys(individualLimit).length
      ? {
          limit: stringOrNull(individualLimit.limit),
          used: stringOrNull(individualLimit.used),
          remainingPercent: numberOrNull(individualLimit.remainingPercent),
          resetsAt: numberOrNull(individualLimit.resetsAt)
        }
      : null,
    planType: stringOrNull(record.planType),
    rateLimitReachedType: stringOrNull(record.rateLimitReachedType)
  };
}

function sanitizeCodexQuota(accountResult: unknown, limitsResult: unknown, usageResult: unknown, errors: string[]): PublicCodexQuota {
  const accountRecord = asRecord(asRecord(accountResult).account);
  const limitsRecord = asRecord(limitsResult);
  const usageRecord = asRecord(usageResult);
  const byLimitIdRecord = asRecord(limitsRecord.rateLimitsByLimitId);
  const rateLimitsByLimitId: Record<string, PublicRateLimitSnapshot> = {};
  for (const [limitId, snapshot] of Object.entries(byLimitIdRecord)) {
    const sanitized = sanitizeRateLimitSnapshot(snapshot);
    if (sanitized) {
      rateLimitsByLimitId[limitId] = sanitized;
    }
  }
  const usageSummary = asRecord(usageRecord.summary);
  const buckets = Array.isArray(usageRecord.dailyUsageBuckets) ? usageRecord.dailyUsageBuckets : [];
  const resetCredits = asRecord(limitsRecord.rateLimitResetCredits);
  return {
    account: Object.keys(accountRecord).length
      ? {
          type: stringOrNull(accountRecord.type),
          planType: stringOrNull(accountRecord.planType)
        }
      : null,
    rateLimits: sanitizeRateLimitSnapshot(limitsRecord.rateLimits),
    rateLimitsByLimitId,
    resetCredits: Object.keys(resetCredits).length ? { availableCount: safeCount(resetCredits.availableCount) } : null,
    usage: Object.keys(usageRecord).length
      ? {
          summary: Object.keys(usageSummary).length
            ? {
                lifetimeTokens: safeCount(usageSummary.lifetimeTokens),
                peakDailyTokens: safeCount(usageSummary.peakDailyTokens),
                longestRunningTurnSec: safeCount(usageSummary.longestRunningTurnSec),
                currentStreakDays: safeCount(usageSummary.currentStreakDays),
                longestStreakDays: safeCount(usageSummary.longestStreakDays)
              }
            : null,
          dailyUsageBuckets: buckets.slice(-30).map((bucket) => {
            const record = asRecord(bucket);
            return {
              startDate: stringOrNull(record.startDate) ?? "",
              tokens: safeCount(record.tokens)
            };
          }).filter((bucket) => bucket.startDate)
        }
      : null,
    errors,
    updatedAt: new Date().toISOString()
  };
}

async function readCodexQuota(bridge: CodexBridge): Promise<PublicCodexQuota> {
  const errors: string[] = [];
  const [accountSettled, limitsSettled, usageSettled] = await Promise.allSettled([
    bridge.request("account/read", { refreshToken: false }, 30_000),
    bridge.request("account/rateLimits/read", undefined, 30_000),
    bridge.request("account/usage/read", undefined, 30_000)
  ]);

  const account = accountSettled.status === "fulfilled" ? accountSettled.value : {};
  const limits = limitsSettled.status === "fulfilled" ? limitsSettled.value : {};
  const usage = usageSettled.status === "fulfilled" ? usageSettled.value : {};
  for (const [name, settled] of [["account", accountSettled], ["rateLimits", limitsSettled], ["usage", usageSettled]] as const) {
    if (settled.status === "rejected") {
      errors.push(`${name}: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`);
    }
  }
  return sanitizeCodexQuota(account, limits, usage, errors);
}

async function readCachedCodexQuota(bridge: CodexBridge, forceRefresh = false): Promise<PublicCodexQuota> {
  const now = Date.now();
  if (!forceRefresh && codexQuotaCache && codexQuotaCache.expiresAt > now) {
    return codexQuotaCache.data;
  }
  if (codexQuotaRefreshInFlight) {
    return codexQuotaRefreshInFlight;
  }

  const refresh = readCodexQuota(bridge)
    .then((data) => {
      codexQuotaCache = { data, expiresAt: Date.now() + codexQuotaCacheTtlMs };
      return data;
    })
    .finally(() => {
      codexQuotaRefreshInFlight = null;
    });
  codexQuotaRefreshInFlight = refresh;
  return refresh;
}

type PublicSkill = {
  name: string;
  displayName: string;
  shortDescription: string | null;
  description: string;
  scope: string | null;
  enabled: boolean;
  defaultPrompt: string | null;
};

function sanitizeSkill(entry: unknown): PublicSkill | null {
  const record = asRecord(entry);
  const name = stringOrNull(record.name);
  if (!name) {
    return null;
  }
  const iface = asRecord(record.interface);
  return {
    name,
    displayName: stringOrNull(iface.displayName) ?? name,
    shortDescription: stringOrNull(record.shortDescription) ?? stringOrNull(iface.shortDescription),
    description: stringOrNull(record.description) ?? "",
    scope: stringOrNull(record.scope),
    enabled: Boolean(record.enabled),
    defaultPrompt: stringOrNull(iface.defaultPrompt)
  };
}

function sanitizeSkillsList(result: unknown): { data: PublicSkill[]; errors: Array<{ cwd: string; path: string; message: string }> } {
  const records = Array.isArray(asRecord(result).data) ? (asRecord(result).data as unknown[]) : [];
  const skillsByName = new Map<string, PublicSkill>();
  const errors: Array<{ cwd: string; path: string; message: string }> = [];
  for (const group of records) {
    const groupRecord = asRecord(group);
    const cwd = stringOrNull(groupRecord.cwd) ?? "";
    const skills = Array.isArray(groupRecord.skills) ? groupRecord.skills : [];
    for (const skill of skills) {
      const sanitized = sanitizeSkill(skill);
      if (sanitized) {
        skillsByName.set(sanitized.name, sanitized);
      }
    }
    const groupErrors = Array.isArray(groupRecord.errors) ? groupRecord.errors : [];
    for (const error of groupErrors) {
      const errorRecord = asRecord(error);
      errors.push({
        cwd,
        path: stringOrNull(errorRecord.path) ?? "",
        message: stringOrNull(errorRecord.message) ?? "Unknown skill error"
      });
    }
  }
  return {
    data: Array.from(skillsByName.values()).sort((left, right) => left.name.localeCompare(right.name)),
    errors
  };
}

type PublicTokenBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

type PublicLeaderboardModelUsage = PublicTokenBreakdown & {
  model: string;
  effort: string | null;
  sessionCount: number;
};

type PublicLeaderboardUserUsage = PublicTokenBreakdown & {
  userId: string;
  sharePercent: number;
  quotaPercent: number | null;
  sessionCount: number;
  models: PublicLeaderboardModelUsage[];
};

type PublicLeaderboardScope = {
  totalTokens: number;
  resetAt: number | null;
  quotaUsedPercent: number | null;
  users: PublicLeaderboardUserUsage[];
};

type PublicCodexLeaderboard = {
  currentCycle: PublicLeaderboardScope;
  lifetime: PublicLeaderboardScope;
  updatedAt: string;
  errors: string[];
};

type TokenAccumulator = PublicTokenBreakdown;

type AggregateBucket = {
  sessions: Set<string>;
  models: Map<string, { model: string; effort: string | null; sessions: Set<string>; totals: TokenAccumulator }>;
  totals: TokenAccumulator;
};

const leaderboardCacheTtlMs = 10_000;
let leaderboardCache: { data: PublicCodexLeaderboard; expiresAt: number; resetAt: number | null } | null = null;
let leaderboardRefreshInFlight: Promise<PublicCodexLeaderboard> | null = null;

function emptyTokenAccumulator(): TokenAccumulator {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function addTokenAccumulator(target: TokenAccumulator, next: Partial<TokenAccumulator>): void {
  target.inputTokens += next.inputTokens ?? 0;
  target.cachedInputTokens += next.cachedInputTokens ?? 0;
  target.cacheWriteInputTokens += next.cacheWriteInputTokens ?? 0;
  target.outputTokens += next.outputTokens ?? 0;
  target.reasoningOutputTokens += next.reasoningOutputTokens ?? 0;
  target.totalTokens += next.totalTokens ?? 0;
}

function round2(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 100) / 100;
}

function walkJsonlFiles(root: string): string[] {
  if (!root || !fs.existsSync(root)) {
    return [];
  }
  const pending = [root];
  const result: string[] = [];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(nextPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        result.push(nextPath);
      }
    }
  }
  return result;
}

function countField(record: Record<string, unknown>, camel: string, snake: string): number {
  return safeCount(record[camel]) ?? safeCount(record[snake]) ?? 0;
}

function userIdFromSessionCwd(cwd: string | null): string | null {
  if (!cwd) {
    return null;
  }
  const normalizedRoot = path.resolve(userWorkspaceRoot);
  const normalizedCwd = path.resolve(cwd);
  if (!normalizedCwd.startsWith(`${normalizedRoot}${path.sep}`)) {
    return null;
  }
  const relative = path.relative(normalizedRoot, normalizedCwd);
  const [firstSegment] = relative.split(path.sep);
  return firstSegment?.trim() || null;
}

function aggregateBucketFor(map: Map<string, AggregateBucket>, userId: string): AggregateBucket {
  let bucket = map.get(userId);
  if (!bucket) {
    bucket = {
      sessions: new Set<string>(),
      models: new Map(),
      totals: emptyTokenAccumulator()
    };
    map.set(userId, bucket);
  }
  return bucket;
}

function recordUsage(
  bucketMap: Map<string, AggregateBucket>,
  userId: string,
  sessionId: string,
  model: string,
  effort: string | null,
  usage: TokenAccumulator
): void {
  if (!usage.totalTokens) {
    return;
  }
  const bucket = aggregateBucketFor(bucketMap, userId);
  bucket.sessions.add(sessionId);
  addTokenAccumulator(bucket.totals, usage);
  const modelKey = `${model}::${effort ?? ""}`;
  let modelBucket = bucket.models.get(modelKey);
  if (!modelBucket) {
    modelBucket = {
      model,
      effort,
      sessions: new Set<string>(),
      totals: emptyTokenAccumulator()
    };
    bucket.models.set(modelKey, modelBucket);
  }
  modelBucket.sessions.add(sessionId);
  addTokenAccumulator(modelBucket.totals, usage);
}

function finalizeLeaderboardScope(
  source: Map<string, AggregateBucket>,
  options: { totalQuotaUsedPercent: number | null; resetAt: number | null }
): PublicLeaderboardScope {
  const totalTokens = Array.from(source.values()).reduce((sum, entry) => sum + entry.totals.totalTokens, 0);
  const users = Array.from(source.entries())
    .map(([userId, bucket]) => {
      const sharePercent = totalTokens > 0 ? round2((bucket.totals.totalTokens / totalTokens) * 100) ?? 0 : 0;
      const quotaPercent = totalTokens > 0 && options.totalQuotaUsedPercent !== null
        ? round2((bucket.totals.totalTokens / totalTokens) * options.totalQuotaUsedPercent)
        : null;
      const models = Array.from(bucket.models.values())
        .map((modelBucket) => ({
          model: modelBucket.model,
          effort: modelBucket.effort,
          sessionCount: modelBucket.sessions.size,
          ...modelBucket.totals
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens || left.model.localeCompare(right.model));
      return {
        userId,
        sharePercent,
        quotaPercent,
        sessionCount: bucket.sessions.size,
        ...bucket.totals,
        models
      };
    })
    .sort((left, right) => right.totalTokens - left.totalTokens || left.userId.localeCompare(right.userId));
  return {
    totalTokens,
    resetAt: options.resetAt,
    quotaUsedPercent: options.totalQuotaUsedPercent,
    users
  };
}

function mergeLeaderboardScopes(scopes: PublicLeaderboardScope[], accountLabels: string[]): PublicLeaderboardScope {
  const buckets = new Map<string, AggregateBucket>();
  for (const [scopeIndex, scope] of scopes.entries()) {
    const accountLabel = accountLabels[scopeIndex] || `账号 ${scopeIndex + 1}`;
    for (const user of scope.users) {
      // The same Web login can use both purchased Codex accounts.  Keep those
      // rows separate instead of silently folding account two into account one.
      const displayUserId = `${user.userId} · ${accountLabel}`;
      const bucket = aggregateBucketFor(buckets, displayUserId);
      // A peer can only observe a count, not individual session IDs.  Use
      // synthetic IDs so the displayed count remains additive across hosts.
      for (let index = 0; index < user.sessionCount; index += 1) {
        bucket.sessions.add(`${displayUserId}:${scopeIndex}:${index}`);
      }
      addTokenAccumulator(bucket.totals, user);
      for (const model of user.models) {
        const key = `${model.model}::${model.effort ?? ""}`;
        let modelBucket = bucket.models.get(key);
        if (!modelBucket) {
          modelBucket = { model: model.model, effort: model.effort, sessions: new Set<string>(), totals: emptyTokenAccumulator() };
          bucket.models.set(key, modelBucket);
        }
        for (let index = 0; index < model.sessionCount; index += 1) {
          modelBucket.sessions.add(`${displayUserId}:${scopeIndex}:${key}:${index}`);
        }
        addTokenAccumulator(modelBucket.totals, model);
      }
    }
  }
  // Separate Codex accounts have separate rate-limit windows, so a merged
  // board deliberately has no misleading single quota percentage/reset time.
  return finalizeLeaderboardScope(buckets, { totalQuotaUsedPercent: null, resetAt: null });
}

async function mergePeerLeaderboards(local: PublicCodexLeaderboard): Promise<PublicCodexLeaderboard> {
  if (!serverConfig.leaderboardPeers.length || !serverConfig.leaderboardPeerToken) {
    return local;
  }
  const peerResults = await Promise.all(serverConfig.leaderboardPeers.map(async (peer) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`${peer}/api/codex/leaderboard?local=true`, {
        headers: { "x-codex-leaderboard-peer-token": serverConfig.leaderboardPeerToken },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { data?: PublicCodexLeaderboard };
      if (!body.data) throw new Error("响应没有排行榜数据");
      return { data: body.data, error: null as string | null };
    } catch (error) {
      return { data: null, error: `${peer}: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }));
  const peers = peerResults.flatMap((result) => result.data ? [result.data] : []);
  const errors = [...local.errors, ...peerResults.flatMap((result) => result.error ? [result.error] : [])];
  if (!peers.length) return { ...local, errors };
  return {
    currentCycle: mergeLeaderboardScopes(
      [local.currentCycle, ...peers.map((peer) => peer.currentCycle)],
      [serverConfig.leaderboardAccountLabel, ...peers.map((_, index) => serverConfig.leaderboardPeerLabels[index] || `远端账号 ${index + 1}`)]
    ),
    lifetime: mergeLeaderboardScopes(
      [local.lifetime, ...peers.map((peer) => peer.lifetime)],
      [serverConfig.leaderboardAccountLabel, ...peers.map((_, index) => serverConfig.leaderboardPeerLabels[index] || `远端账号 ${index + 1}`)]
    ),
    updatedAt: new Date().toISOString(),
    errors
  };
}

function readCodexLeaderboard(currentQuota: PublicCodexQuota, store: ProjectStore): PublicCodexLeaderboard {
  const sessionsRoot = path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME ?? process.cwd(), ".codex"), "sessions");
  const files = walkJsonlFiles(sessionsRoot);
  const currentResetAt = currentQuota.rateLimits?.primary?.resetsAt ?? null;
  const currentQuotaUsedPercent = currentQuota.rateLimits?.primary?.usedPercent ?? null;
  const lifetime = new Map<string, AggregateBucket>();
  const currentCycle = new Map<string, AggregateBucket>();
  const errors: string[] = [];
  const ownerUserCache = new Map<string, string | null>();

  const resolveSessionOwner = (sessionId: string): string | null => {
    if (ownerUserCache.has(sessionId)) {
      return ownerUserCache.get(sessionId) ?? null;
    }
    const owner = store.getThreadOwner(sessionId);
    const userId = owner?.userId?.trim() || null;
    ownerUserCache.set(sessionId, userId);
    return userId;
  };

  for (const filePath of files) {
    try {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      let sessionId = path.basename(filePath, ".jsonl");
      let userId: string | null = null;
      let model = "unknown";
      let effort: string | null = null;
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = stringOrNull(record.type);
        const payload = asRecord(record.payload);
        if (type === "session_meta") {
          sessionId = stringOrNull(payload.session_id) ?? stringOrNull(payload.id) ?? sessionId;
          userId = userId ?? resolveSessionOwner(sessionId) ?? userIdFromSessionCwd(stringOrNull(payload.cwd));
          continue;
        }
        if (type === "turn_context") {
          userId = userId ?? resolveSessionOwner(sessionId) ?? userIdFromSessionCwd(stringOrNull(payload.cwd));
          model = stringOrNull(payload.model) ?? model;
          effort = stringOrNull(payload.effort) ?? stringOrNull(asRecord(payload.collaboration_mode).settings && asRecord(asRecord(payload.collaboration_mode).settings).reasoning_effort) ?? effort;
          continue;
        }
        if (type !== "event_msg" || stringOrNull(payload.type) !== "token_count") {
          continue;
        }
        if (!userId) {
          userId = resolveSessionOwner(sessionId) ?? userIdFromSessionCwd(stringOrNull(payload.cwd)) ?? "unknown";
        }
        const info = asRecord(payload.info);
        const usageRecord = asRecord(info.last_token_usage);
        const fallbackUsageRecord = asRecord(info.total_token_usage);
        const usageSource = Object.keys(usageRecord).length ? usageRecord : fallbackUsageRecord;
        const usage: TokenAccumulator = {
          inputTokens: countField(usageSource, "inputTokens", "input_tokens"),
          cachedInputTokens: countField(usageSource, "cachedInputTokens", "cached_input_tokens"),
          cacheWriteInputTokens: countField(usageSource, "cacheWriteInputTokens", "cache_write_input_tokens"),
          outputTokens: countField(usageSource, "outputTokens", "output_tokens"),
          reasoningOutputTokens: countField(usageSource, "reasoningOutputTokens", "reasoning_output_tokens"),
          totalTokens: countField(usageSource, "totalTokens", "total_tokens")
        };
        recordUsage(lifetime, userId, sessionId, model, effort, usage);
        const primary = asRecord(asRecord(payload.rate_limits).primary);
        const resetAt = safeCount(primary.resets_at) ?? safeCount(primary.resetsAt);
        if (currentResetAt !== null && resetAt === currentResetAt) {
          recordUsage(currentCycle, userId, sessionId, model, effort, usage);
        }
      }
    } catch (error) {
      errors.push(`${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    currentCycle: finalizeLeaderboardScope(currentCycle, {
      totalQuotaUsedPercent: currentQuotaUsedPercent,
      resetAt: currentResetAt
    }),
    lifetime: finalizeLeaderboardScope(lifetime, {
      totalQuotaUsedPercent: null,
      resetAt: null
    }),
    updatedAt: new Date().toISOString(),
    errors
  };
}

async function readCachedCodexLeaderboard(
  currentQuota: PublicCodexQuota,
  store: ProjectStore,
  forceRefresh = false,
  includePeers = true
): Promise<PublicCodexLeaderboard> {
  const now = Date.now();
  const resetAt = currentQuota.rateLimits?.primary?.resetsAt ?? null;
  if (includePeers && !forceRefresh && leaderboardCache && leaderboardCache.expiresAt > now && leaderboardCache.resetAt === resetAt) {
    return leaderboardCache.data;
  }
  if (includePeers && leaderboardRefreshInFlight) {
    return leaderboardRefreshInFlight;
  }
  const refresh = Promise.resolve(readCodexLeaderboard(currentQuota, store))
    .then((local) => includePeers ? mergePeerLeaderboards(local) : local)
    .then((data) => {
      if (includePeers) {
        leaderboardCache = { data, expiresAt: Date.now() + leaderboardCacheTtlMs, resetAt };
      }
      return data;
    })
    .finally(() => {
      if (includePeers) {
        leaderboardRefreshInFlight = null;
      }
    });
  if (includePeers) {
    leaderboardRefreshInFlight = refresh;
  }
  return refresh;
}

function fileKind(filePath: string): "markdown" | "text" | "image" | "pdf" | "binary" {
  const extension = path.extname(filePath).toLowerCase();
  if (markdownExtensions.has(extension)) {
    return "markdown";
  }
  if (textExtensions.has(extension)) {
    return "text";
  }
  if (imageExtensions.has(extension)) {
    return "image";
  }
  if (extension === ".pdf") {
    return "pdf";
  }
  return "binary";
}

function mimeTypeForPath(filePath: string): string {
  return mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function rawFileUrl(projectId: string, relativePath: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/files/raw?path=${encodeURIComponent(relativePath)}`;
}

function safeUploadName(filename: string): string {
  const basename = path.basename(filename).normalize("NFC").replace(/[^\w.\-() \u4e00-\u9fff]/g, "_");
  return basename.replace(/^\.+$/, "") || "upload";
}

function safeFolderSegment(value: string, fallback: string): string {
  const segment = value.normalize("NFC").replace(/[^\w.\-() \u4e00-\u9fff]/g, "_").replace(/^\.+$/, "");
  return segment || fallback;
}

function timestampSegment(date = new Date()): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    pad(date.getMilliseconds(), 3)
  ].join("_");
}

function uploadBatchDirectory(username: string): string {
  return path.join(uploadRoot, safeFolderSegment(username, "anonymous"), timestampSegment());
}

function uniqueUploadTarget(projectRoot: string, batchDirectory: string, filename: string): { filePath: string; relativePath: string } {
  const safeName = safeUploadName(filename);
  const parsed = path.parse(safeName);
  const root = path.resolve(batchDirectory);
  for (let index = 0; index < 10_000; index += 1) {
    const name = index === 0 ? safeName : `${parsed.name}-${index + 1}${parsed.ext}`;
    const candidate = path.resolve(root, name);
    if (!candidate.startsWith(`${root}${path.sep}`)) {
      throw new Error("Invalid upload filename.");
    }
    const target = resolveProjectFilePath(projectRoot, candidate, {
      mustExist: false,
      allowOutsideRoot: true
    });
    if (!fs.existsSync(target.filePath)) {
      return target;
    }
  }
  throw new Error("Unable to allocate a unique upload filename.");
}

async function saveMultipartFile(projectRoot: string, batchDirectory: string, part: MultipartFile): Promise<{
  name: string;
  path: string;
  relativePath: string;
  size: number;
  mime: string;
  rawUrl: string;
}> {
  const target = uniqueUploadTarget(projectRoot, batchDirectory, part.filename || "upload");
  fs.mkdirSync(path.dirname(target.filePath), { recursive: true, mode: 0o700 });
  await pipeline(part.file, fs.createWriteStream(target.filePath, { flags: "wx", mode: 0o600 }));
  const stat = fs.statSync(target.filePath);
  return {
    name: path.basename(target.filePath),
    path: target.filePath,
    relativePath: target.relativePath,
    size: stat.size,
    mime: part.mimetype || mimeTypeForPath(target.filePath),
    rawUrl: ""
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\''`)}'`;
}

function expandHomePath(value: string): string {
  if (value === "~") {
    return process.env.HOME ?? value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", value.slice(2));
  }
  return value;
}

function cleanSshScalar(value: string, label: string): string {
  const cleaned = value.trim();
  if (/[\0\r\n]/.test(cleaned)) {
    throw new Error(`${label} 不能包含换行或 NUL 字符。`);
  }
  return cleaned;
}

function settingsForCurrentAccessDevice(
  settings: ReturnType<ProjectStore["getLocalSendSettings"]>,
  request: { headers: Record<string, unknown>; ip?: string }
): ReturnType<ProjectStore["getLocalSendSettings"]> {
  const savedHost = cleanSshScalar(settings.sshHost, "当前访问设备 SSH 地址");
  // A user-provided SSH address is deliberate (often a ZeroTier address or a
  // hostname).  It must win over the browser source IP so saved settings are
  // actually used for every transfer.  The source IP remains a convenience
  // fallback only when the user intentionally leaves the setting blank.
  if (savedHost) {
    return settings;
  }
  const detected = cleanSshScalar(requestClientHost(request), "当前访问设备 IP");
  return detected ? { ...settings, sshHost: detected } : settings;
}

function validateLocalSendSettings(settings: ReturnType<ProjectStore["getLocalSendSettings"]>, destinationPathOverride?: string) {
  const sshHost = cleanSshScalar(settings.sshHost, "当前访问设备 SSH 地址");
  const sshUser = cleanSshScalar(settings.sshUser, "SSH 用户");
  const destinationPath = cleanSshScalar(destinationPathOverride ?? settings.destinationPath, "访问设备保存目录");
  const identityFile = cleanSshScalar(settings.identityFile, "私钥路径");
  const sshPort = Math.trunc(settings.sshPort || 22);
  if (!sshHost || !sshUser || !destinationPath) {
    throw new Error("请先在设置里填写 SSH 用户名和访问设备保存目录；SSH 地址留空时才使用当前浏览器来源 IP。");
  }
  if (sshHost.startsWith("-") || /\s/.test(sshHost)) {
    throw new Error("当前访问设备 SSH 地址格式不正确。");
  }
  if (sshUser.startsWith("-") || /[\s@]/.test(sshUser)) {
    throw new Error("SSH 用户名格式不正确。");
  }
  if (sshPort < 1 || sshPort > 65535) {
    throw new Error("SSH 端口必须在 1-65535 之间。");
  }
  return { sshHost, sshUser, sshPort, destinationPath, identityFile };
}

function localSshOptions(clean: ReturnType<typeof validateLocalSendSettings>, portFlag: "-p" | "-P" = "-p"): string[] {
  const identityOptions = clean.identityFile ? ["-i", expandHomePath(clean.identityFile)] : [];
  return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", ...identityOptions, portFlag, String(clean.sshPort)];
}

async function testLocalSendSettingsViaSsh(settings: ReturnType<ProjectStore["getLocalSendSettings"]>) {
  const clean = validateLocalSendSettings(settings);
  const sshTarget = `${clean.sshUser}@${clean.sshHost}`;
  const probeName = `.codex-web-ssh-test-${process.pid}-${Date.now()}`;
  const localProbe = path.join(uploadRoot, probeName);
  const remoteProbe = remoteJoin(clean.destinationPath, probeName);
  fs.mkdirSync(uploadRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(localProbe, "codex-web ssh transfer test\n", { mode: 0o600 });
  let transferred = false;
  try {
    await execFileAsync(
      "ssh",
      [...localSshOptions(clean), sshTarget, `mkdir -p -- ${shellQuote(clean.destinationPath)}`],
      { timeout: 30_000, maxBuffer: 512 * 1024 }
    );
    await execFileAsync(
      "scp",
      [...localSshOptions(clean, "-P"), localProbe, `${sshTarget}:${shellQuote(remoteProbe)}`],
      { timeout: 30_000, maxBuffer: 512 * 1024 }
    );
    transferred = true;
  } finally {
    fs.rmSync(localProbe, { force: true });
    if (transferred) {
      await execFileAsync(
        "ssh",
        [...localSshOptions(clean), sshTarget, `rm -f -- ${shellQuote(remoteProbe)}`],
        { timeout: 30_000, maxBuffer: 512 * 1024 }
      ).catch(() => undefined);
    }
  }
  return {
    sshHost: clean.sshHost,
    sshUser: clean.sshUser,
    sshPort: clean.sshPort,
    destinationPath: clean.destinationPath
  };
}

function remoteJoin(directory: string, filename: string): string {
  const base = directory.replace(/\/+$/, "");
  return base ? `${base}/${filename}` : filename;
}

async function sendFileToLocalViaSsh(settings: ReturnType<ProjectStore["getLocalSendSettings"]>, sourcePath: string, destinationPathOverride?: string) {
  const clean = validateLocalSendSettings(settings, destinationPathOverride);
  const filename = path.basename(sourcePath);
  const remoteFile = remoteJoin(clean.destinationPath, filename);
  const sshTarget = `${clean.sshUser}@${clean.sshHost}`;
  const sshOptions = localSshOptions(clean);

  await execFileAsync(
    "ssh",
    [...sshOptions, sshTarget, `mkdir -p -- ${shellQuote(clean.destinationPath)}`],
    { timeout: 30_000, maxBuffer: 512 * 1024 }
  );
  const { stdout, stderr } = await execFileAsync(
    "scp",
    [...localSshOptions(clean, "-P"), sourcePath, `${sshTarget}:${shellQuote(remoteFile)}`],
    { timeout: 120_000, maxBuffer: 1024 * 1024 }
  );
  return {
    sshHost: clean.sshHost,
    sshUser: clean.sshUser,
    sshPort: clean.sshPort,
    destinationPath: clean.destinationPath,
    remoteFile,
    stdout,
    stderr
  };
}

function validateServerOutputPath(value: string | undefined, settings: ReturnType<ProjectStore["getLocalSendSettings"]>): string {
  const outputPath = cleanSshScalar(value?.trim() || settings.outputPath || "/tmp/codex_remote_exports", "服务端临时中转目录");
  if (!outputPath) {
    throw new Error("请先在设置里填写服务端临时中转目录。");
  }
  return resolveProjectPath(expandHomePath(outputPath), serverConfig.projectRoot, { allowOutsideRoot: true });
}

function exportFileName(thread: Record<string, unknown>, threadId: string, format: "markdown" | "json"): string {
  const title = stringOrNull(thread.name) ?? stringOrNull(thread.preview) ?? threadId;
  const compactTitle = safeFolderSegment(title.split(/\r?\n/)[0]?.slice(0, 48) || threadId, "thread");
  return safeUploadName(`${timestampSegment()}_${compactTitle}.${format === "markdown" ? "md" : "json"}`);
}

function exportItemLabel(item: Record<string, unknown>): string {
  const token = `${String(item.role ?? "")} ${String(item.type ?? "")} ${String(item.tool ?? "")}`.toLowerCase();
  if (token.includes("user")) {
    return "用户";
  }
  if (token.includes("assistant") || token.includes("agent")) {
    return "Codex";
  }
  if (token.includes("tool") || token.includes("command") || typeof item.command === "string" || typeof item.aggregatedOutput === "string") {
    return item.tool ? `工具 · ${String(item.tool)}` : "工具";
  }
  return String(item.type ?? "系统") || "系统";
}

function exportItemText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof item.command === "string" && item.command.trim()) {
    parts.push(`命令：\n\n\`\`\`bash\n${item.command.trim()}\n\`\`\``);
  } else {
    const text = searchableTextFromValue(item.text ?? item.message ?? item.content ?? item.input ?? item.prompt ?? item.value ?? item.output).trim();
    if (text) {
      parts.push(text);
    }
  }
  if (typeof item.savedPath === "string" && item.savedPath.trim()) {
    parts.push(`文件：${item.savedPath.trim()}`);
  }
  if (typeof item.imagePath === "string" && item.imagePath.trim() && item.imagePath !== item.savedPath) {
    parts.push(`图片：${item.imagePath.trim()}`);
  }
  if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput.trim()) {
    parts.push(`输出：\n\n\`\`\`text\n${item.aggregatedOutput.trim()}\n\`\`\``);
  }
  return parts.join("\n\n").trim();
}

function renderThreadMarkdown(thread: Record<string, unknown>, project: { name: string; rootPath: string }, threadId: string): string {
  const title = stringOrNull(thread.name) ?? stringOrNull(thread.preview) ?? threadId;
  const createdAt = numberOrNull(thread.createdAt) ? new Date((numberOrNull(thread.createdAt) ?? 0) * 1000).toISOString() : "";
  const updatedAt = numberOrNull(thread.updatedAt) ? new Date((numberOrNull(thread.updatedAt) ?? 0) * 1000).toISOString() : "";
  const lines: string[] = [
    `# ${title}`,
    "",
    `- Thread ID: ${threadId}`,
    `- Project: ${project.name}`,
    `- Project path: ${project.rootPath}`,
    `- Exported at: ${new Date().toISOString()}`
  ];
  if (createdAt) lines.push(`- Created at: ${createdAt}`);
  if (updatedAt) lines.push(`- Updated at: ${updatedAt}`);
  lines.push("");

  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  turns.forEach((turnValue, turnIndex) => {
    const turn = asRecord(turnValue);
    lines.push(`## Turn ${turnIndex + 1}`);
    lines.push("");
    const items = Array.isArray(turn.items) ? turn.items : [];
    items.forEach((itemValue) => {
      const item = asRecord(itemValue);
      const body = exportItemText(item);
      if (!body) {
        return;
      }
      lines.push(`### ${exportItemLabel(item)}`);
      lines.push("");
      lines.push(body);
      lines.push("");
    });
  });

  return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
}

function renderThreadExport(thread: Record<string, unknown>, project: { name: string; rootPath: string }, threadId: string, format: "markdown" | "json"): { content: string; mime: string } {
  if (format === "json") {
    return {
      content: `${JSON.stringify({ exportedAt: new Date().toISOString(), project, thread }, null, 2)}\n`,
      mime: "application/json; charset=utf-8"
    };
  }
  return {
    content: renderThreadMarkdown(thread, project, threadId),
    mime: "text/markdown; charset=utf-8"
  };
}

function errorStatus(error: unknown): number {
  if (error instanceof PathPolicyError || error instanceof z.ZodError) {
    return 400;
  }
  return 500;
}

function loginUserIdFromRequest(request: { headers: Record<string, unknown> }): string {
  const username = authenticatedUserFromHeaders(request.headers as any);
  if (!username || username === "auth-disabled") {
    return DEFAULT_USER_ID;
  }
  return username.trim() || DEFAULT_USER_ID;
}

function currentUserFromRequest(request: { headers: Record<string, unknown> }, store: ProjectStore) {
  const userId = loginUserIdFromRequest(request);
  return store.ensureUser(userId, userId);
}

function userIdFromRequest(request: { headers: Record<string, unknown> }, store: ProjectStore): string {
  return currentUserFromRequest(request, store).id;
}

function requestHostname(request: { headers: Record<string, unknown>; hostname?: string }): string {
  const host = typeof request.headers.host === "string" ? request.headers.host : request.hostname ?? "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return (end === -1 ? host.slice(1) : host.slice(1, end)).toLowerCase();
  }
  return host.split(":")[0].toLowerCase();
}

function requestClientHost(request: { headers: Record<string, unknown>; ip?: string }): string {
  const forwarded = request.headers["x-forwarded-for"];
  const raw = typeof forwarded === "string" && forwarded.trim()
    ? forwarded.split(",")[0]?.trim()
    : request.ip ?? "";
  return raw.replace(/^::ffff:/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname === "0:0:0:0:0:0:0:1" || hostname === "127.0.0.1" || hostname.startsWith("127.");
}

function systemDirectoryPickerAvailableForRequest(request: { headers: Record<string, unknown>; hostname?: string }): boolean {
  return process.platform === "darwin" && isLoopbackHostname(requestHostname(request));
}

function threadIdFromListItem(item: unknown): string | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const record = item as { id?: unknown; threadId?: unknown };
  if (typeof record.id === "string" && record.id.trim()) {
    return record.id;
  }
  if (typeof record.threadId === "string" && record.threadId.trim()) {
    return record.threadId;
  }
  return null;
}

function normalizeSearchTerm(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function searchTerms(query: string): string[] {
  return normalizeSearchTerm(query).split(/\s+/).filter(Boolean);
}

function searchableTextFromValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 5) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 120).map((item) => searchableTextFromValue(item, depth + 1)).join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(token|secret|authorization|cookie|api[_-]?key)/i.test(key))
      .slice(0, 120)
      .map(([, item]) => searchableTextFromValue(item, depth + 1))
      .join("\n");
  }
  return "";
}

function itemMatchesSearch(item: unknown, query: string): boolean {
  if (!query) {
    return true;
  }
  const text = searchableTextFromValue(item).toLowerCase();
  return text.includes(query) || searchTerms(query).every((term) => text.includes(term));
}

function listItemUpdatedAt(item: unknown): number {
  const record = asRecord(item);
  return numberOrNull(record.updatedAt) ?? numberOrNull(record.updated_at) ?? numberOrNull(record.recencyAt) ?? 0;
}

function listItemSummaryFromThread(thread: unknown): unknown {
  const record = asRecord(thread);
  return {
    ...record,
    turns: [],
    preview: stringOrNull(record.preview) ?? stringOrNull(record.name) ?? "",
    updatedAt: numberOrNull(record.updatedAt) ?? numberOrNull(record.updated_at) ?? 0,
    createdAt: numberOrNull(record.createdAt) ?? numberOrNull(record.created_at) ?? 0,
    status: record.status ?? { type: "notLoaded" }
  };
}

function sanitizeThreadPayloadForClient<T>(value: T): T {
  const root = asRecord(value);
  const thread = asRecord(root.thread ?? value);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turnValue of turns) {
    const turn = asRecord(turnValue);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const itemValue of items) {
      const item = asRecord(itemValue);
      const itemType = typeof item.type === "string" ? item.type : "";
      const savedPath = stringOrNull(item.savedPath) ?? stringOrNull(item.saved_path) ?? stringOrNull(item.imagePath) ?? stringOrNull(item.image_path);
      if (savedPath && /image/i.test(itemType)) {
        item.savedPath = savedPath;
        item.imagePath = savedPath;
        if (typeof item.result === "string" && item.result.length > 1024) {
          delete item.result;
          item.resultOmitted = true;
        }
      }
    }
  }
  return value;
}

function hasRenderableThreadTurns(value: unknown): boolean {
  const thread = asRecord(value);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return turns.some((turn) => {
    const items = Array.isArray(asRecord(turn).items) ? asRecord(turn).items as unknown[] : [];
    return items.some((item) => {
      const record = asRecord(item);
      if (typeof record.text === "string" && record.text.trim()) {
        return true;
      }
      if (typeof record.command === "string" && record.command.trim()) {
        return true;
      }
      if (typeof record.aggregatedOutput === "string" && record.aggregatedOutput.trim()) {
        return true;
      }
      if (Array.isArray(record.content) && searchableTextFromValue(record.content).trim()) {
        return true;
      }
      if (Array.isArray(record.summary) && record.summary.length) {
        return true;
      }
      return false;
    });
  });
}

async function readThreadPreferJsonlFallback(threadId: string, bridgeResult: unknown): Promise<unknown> {
  const thread = asRecord(asRecord(bridgeResult).thread);
  if (hasRenderableThreadTurns(thread)) {
    return sanitizeThreadPayloadForClient(bridgeResult);
  }
  const fallbackPath = await findThreadJsonlPathById(threadId);
  if (!fallbackPath) {
    return sanitizeThreadPayloadForClient(bridgeResult);
  }
  const fallback = sanitizeThreadPayloadForClient(await readThreadFromJsonl(fallbackPath, threadId));
  return hasRenderableThreadTurns(asRecord(fallback).thread) ? fallback : sanitizeThreadPayloadForClient(bridgeResult);
}

async function readOwnedThreadForList(bridge: CodexBridge, threadId: string): Promise<unknown | null> {
  // The persisted session is both faster and more complete than app-server's
  // global list recovery for an old thread.
  const fallbackPath = await findThreadJsonlPathById(threadId);
  if (fallbackPath) {
    return asRecord(await readThreadFromJsonl(fallbackPath, threadId)).thread ?? null;
  }
  try {
    const result = await bridge.request("thread/read", { threadId, includeTurns: true }, 30_000);
    return asRecord(result).thread ?? null;
  } catch {
    return null;
  }
}

async function threadMatchesSearch(bridge: CodexBridge, item: unknown, query: string): Promise<boolean> {
  if (!query || itemMatchesSearch(item, query)) {
    return true;
  }
  const threadId = threadIdFromListItem(item);
  if (!threadId) {
    return false;
  }
  const fallbackPath = await findThreadJsonlPathById(threadId);
  if (fallbackPath) {
    return threadJsonlMatchesSearch(fallbackPath, query);
  }
  const fullThread = await readOwnedThreadForList(bridge, threadId);
  return itemMatchesSearch(fullThread, query);
}

async function searchOwnedThreadList(bridge: CodexBridge, ownedThreadIds: Set<string>, searchTerm: string): Promise<unknown[]> {
  const threadIds = [...ownedThreadIds];
  const matches: unknown[] = [];
  let nextIndex = 0;
  // Local JSONL scanning is I/O-bound. A small bounded pool is responsive for
  // several users while avoiding a burst of full-file reads on the server.
  const workerCount = Math.min(3, threadIds.length);
  const worker = async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= threadIds.length) {
        return;
      }
      const threadId = threadIds[index];
      const fallbackPath = await findThreadJsonlPathById(threadId);
      if (fallbackPath) {
        if (await threadJsonlMatchesSearch(fallbackPath, searchTerm)) {
          try {
            matches.push(await readThreadSummaryFromJsonl(fallbackPath, threadId));
          } catch {
            // Keep searching remaining owned sessions if one historical file is unreadable.
          }
        }
        continue;
      }
      const fullThread = await readOwnedThreadForList(bridge, threadId);
      if (fullThread && itemMatchesSearch(fullThread, searchTerm)) {
        matches.push(listItemSummaryFromThread(fullThread));
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return matches.sort((left, right) => listItemUpdatedAt(right) - listItemUpdatedAt(left));
}

async function filterOwnedThreadList(bridge: CodexBridge, items: unknown[], ownedThreadIds: Set<string>, searchTerm: string): Promise<unknown[]> {
  const byId = new Map<string, unknown>();
  for (const item of items) {
    const threadId = threadIdFromListItem(item);
    if (threadId && ownedThreadIds.has(threadId)) {
      byId.set(threadId, item);
    }
  }

  for (const threadId of ownedThreadIds) {
    if (byId.has(threadId)) {
      continue;
    }
    const fullThread = await readOwnedThreadForList(bridge, threadId);
    // Ownership is the access boundary. A legacy session can retain an old cwd
    // after the user's default workspace is moved.
    if (fullThread) {
      byId.set(threadId, listItemSummaryFromThread(fullThread));
    }
  }

  const filtered: unknown[] = [];
  for (const item of byId.values()) {
    if (await threadMatchesSearch(bridge, item, searchTerm)) {
      filtered.push(item);
    }
  }
  return filtered.sort((left, right) => listItemUpdatedAt(right) - listItemUpdatedAt(left));
}

function userWorkspacePath(userId: string): string {
  return path.join(userWorkspaceRoot, safeFolderSegment(userId, "user"));
}

function isUserWorkspaceProject(project: { rootPath: string }, userId: string): boolean {
  return project.rootPath === userWorkspacePath(userId);
}

function ensureProjectsForUser(store: ProjectStore, userId: string) {
  const rootPath = userWorkspacePath(userId);
  fs.mkdirSync(rootPath, { recursive: true, mode: 0o700 });

  // List the personal workspace first: a newly opened page selects it by
  // default. Existing projects (including historical conversations)
  // are deliberately retained below it.
  const workspace = store.getProjectByRootPath(rootPath, userId) ?? store.createProject({
    name: "我的工作区",
    rootPath,
    userId
  });
  const otherProjects = store.listProjects(userId).filter((project) => project.id !== workspace.id);
  return [workspace, ...otherProjects];
}

export function registerRoutes(app: FastifyInstance, bridge: CodexBridge, store: ProjectStore): void {
  app.get("/api/health", async (request) => ({
    ok: true,
    codexPendingApprovals: bridge.getPendingServerRequests().length,
    projectRoot: serverConfig.projectRoot,
    allowOutsideProjectRoot: serverConfig.allowOutsideProjectRoot,
    systemDirectoryPickerAvailable: systemDirectoryPickerAvailableForRequest(request),
    defaults
  }));

  app.get("/api/models", async () => ({
    data: listModelProfiles(),
    defaultModel: defaults.model,
    defaultReasoningEffort: defaults.reasoningEffort
  }));

  app.get<{ Querystring: { refresh?: string } }>("/api/codex/quota", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      return { data: await readCachedCodexQuota(bridge, request.query.refresh === "true") };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Querystring: { refresh?: string; local?: string } }>("/api/codex/leaderboard", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      const quota = await readCachedCodexQuota(bridge, request.query.refresh === "true");
    return { data: await readCachedCodexLeaderboard(quota, store, request.query.refresh === "true", request.query.local !== "true") };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Querystring: { projectId?: string; reload?: string } }>("/api/codex/skills", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = request.query.projectId ? store.getProject(request.query.projectId, userId) : null;
      if (request.query.projectId && !project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const result = await bridge.request("skills/list", {
        cwds: project ? [project.rootPath] : undefined,
        forceReload: request.query.reload === "true"
      }, 30_000);
      return sanitizeSkillsList(result);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/users", async (request) => {
    const user = currentUserFromRequest(request, store);
    return {
      data: [user],
      defaultUserId: user.id,
      lockedToLoginUser: true
    };
  });

  app.post("/api/users", async (_request, reply) => {
    return reply.code(403).send({ error: "用户已绑定为当前登录姓名，不允许添加或切换到其他用户。" });
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (_request, reply) => {
    return reply.code(403).send({ error: "用户已绑定为当前登录姓名，不允许删除或切换到其他用户。" });
  });

  app.get("/api/settings/local-send", async (request) => {
    const userId = userIdFromRequest(request, store);
    return {
      data: store.getLocalSendSettings(userId),
      detectedClientHost: requestClientHost(request)
    };
  });

  app.patch("/api/settings/local-send", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const input = localSendSettingsSchema.parse(request.body);
      return { data: store.updateLocalSendSettings(userId, input) };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/settings/local-send/test", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      // Saved host takes precedence; the browser source IP is used only for an
      // intentionally blank host setting.
      const data = await testLocalSendSettingsViaSsh(settingsForCurrentAccessDevice(store.getLocalSendSettings(userId), request));
      return { data };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/projects", async (request) => {
    const userId = userIdFromRequest(request, store);
    return {
      data: ensureProjectsForUser(store, userId),
      projectRoot: serverConfig.projectRoot,
      allowOutsideProjectRoot: serverConfig.allowOutsideProjectRoot,
      systemDirectoryPickerAvailable: systemDirectoryPickerAvailableForRequest(request)
    };
  });

  app.get<{ Querystring: { path?: string } }>("/api/system/directories", async (request, reply) => {
    try {
      return {
        data: listBrowsableDirectories(request.query.path, serverConfig.projectRoot, {
          allowOutsideRoot: serverConfig.allowOutsideProjectRoot
        })
      };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/system/select-directory", async (request, reply) => {
    if (!systemDirectoryPickerAvailableForRequest(request)) {
      return reply.code(501).send({
        error: "system-directory-picker-unavailable",
        message: "System directory picker is only available when this service is opened locally on the host machine."
      });
    }

    try {
      const script = [
        `set defaultFolder to POSIX file ${JSON.stringify(serverConfig.projectRoot)}`,
        'set selectedFolder to choose folder with prompt "选择本地项目目录" default location defaultFolder',
        "POSIX path of selectedFolder"
      ].join("\n");
      const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 120_000 });
      const selectedPath = stdout.trim().replace(/\/+$/, "");
      const rootPath = resolveProjectPath(selectedPath || serverConfig.projectRoot, serverConfig.projectRoot, {
        allowOutsideRoot: serverConfig.allowOutsideProjectRoot
      });
      return { data: { rootPath } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("User canceled")) {
        return reply.code(499).send({ error: "Directory selection was canceled." });
      }
      return reply.code(errorStatus(error)).send({ error: message });
    }
  });

  app.post("/api/projects", async (request, reply) => {
    try {
      const input = createProjectSchema.parse(request.body);
      const userId = userIdFromRequest(request, store);
      if (!store.getUser(userId)) {
        return reply.code(404).send({ error: "User not found." });
      }
      const rootPath = ensureProjectDirectory(input.rootPath, {
        create: input.createDirectory,
        allowOutsideRoot: serverConfig.allowOutsideProjectRoot
      });
      const existingProject = store.getProjectByRootPath(rootPath, userId);
      if (existingProject) {
        return { data: existingProject };
      }

      if (input.gitInit && !fs.existsSync(`${rootPath}/.git`)) {
        execFileSync("git", ["init"], { cwd: rootPath, stdio: "ignore" });
      }

      const project = store.createProject({ ...input, rootPath, userId });
      return reply.code(201).send({ data: project });
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    try {
      const input = updateProjectSchema.parse(request.body);
      const project = store.updateProject(request.params.id, input, userIdFromRequest(request, store));
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      return { data: project };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const deleted = store.deleteProject(request.params.id, userIdFromRequest(request, store));
    if (!deleted) {
      return reply.code(404).send({ error: "Project not found." });
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/projects/:id/files/preview", async (request, reply) => {
    const project = store.getProject(request.params.id, userIdFromRequest(request, store));
    if (!project) {
      return reply.code(404).send({ error: "Project not found." });
    }
    if (!request.query.path) {
      return reply.code(400).send({ error: "File path is required." });
    }

    try {
      const target = resolveProjectFilePath(project.rootPath, request.query.path, {
        allowOutsideRoot: serverConfig.allowOutsideProjectRoot
      });
      const stat = fs.statSync(target.filePath);
      if (!stat.isFile()) {
        return reply.code(400).send({ error: "Path is not a file." });
      }

      const kind = fileKind(target.filePath);
      const content = kind === "markdown" || kind === "text"
        ? fs.readFileSync(target.filePath).subarray(0, maxPreviewBytes).toString("utf8")
        : undefined;
      return {
        data: {
          name: path.basename(target.filePath),
          path: target.filePath,
          relativePath: target.relativePath,
          line: target.line,
          size: stat.size,
          kind,
          mime: mimeTypeForPath(target.filePath),
          rawUrl: rawFileUrl(project.id, target.relativePath),
          truncated: stat.size > maxPreviewBytes,
          content
        }
      };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/projects/:id/files/raw", async (request, reply) => {
    const project = store.getProject(request.params.id, userIdFromRequest(request, store));
    if (!project) {
      return reply.code(404).send({ error: "Project not found." });
    }
    if (!request.query.path) {
      return reply.code(400).send({ error: "File path is required." });
    }

    try {
      const target = resolveProjectFilePath(project.rootPath, request.query.path, {
        allowOutsideRoot: serverConfig.allowOutsideProjectRoot
      });
      const stat = fs.statSync(target.filePath);
      if (!stat.isFile()) {
        return reply.code(400).send({ error: "Path is not a file." });
      }
      const filename = path.basename(target.filePath).replace(/"/g, "'");
      return reply
        .type(mimeTypeForPath(target.filePath))
        .header("Content-Length", String(stat.size))
        .header("Content-Disposition", `inline; filename="${filename}"`)
        .send(fs.createReadStream(target.filePath));
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/files/send-local", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const project = store.getProject(request.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found." });
    }

    try {
      const input = sendLocalFileSchema.parse(request.body);
      const target = resolveProjectFilePath(project.rootPath, input.path, {
        allowOutsideRoot: serverConfig.allowOutsideProjectRoot
      });
      const stat = fs.statSync(target.filePath);
      if (!stat.isFile()) {
        return reply.code(400).send({ error: "Path is not a file." });
      }
      const result = await sendFileToLocalViaSsh(settingsForCurrentAccessDevice(store.getLocalSendSettings(userId), request), target.filePath, input.destinationPath);
      return {
        data: {
          sourcePath: target.filePath,
          relativePath: target.relativePath,
          name: path.basename(target.filePath),
          size: stat.size,
          ...result
        }
      };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/files/upload", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const project = store.getProject(request.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found." });
    }

    try {
      const saved = [];
      const batchDirectory = uploadBatchDirectory(userId);
      for await (const part of request.files({ limits: { fileSize: 64 * 1024 * 1024, files: 12 } })) {
        const file = await saveMultipartFile(project.rootPath, batchDirectory, part);
        saved.push({
          ...file,
          uploadDir: batchDirectory,
          rawUrl: rawFileUrl(project.id, file.relativePath)
        });
      }
      if (!saved.length) {
        return reply.code(400).send({ error: "No files were uploaded." });
      }
      return reply.code(201).send({ data: saved });
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { archived?: string; search?: string } }>(
    "/api/projects/:id/threads",
    async (request, reply) => {
      const project = store.getProject(request.params.id, userIdFromRequest(request, store));
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }

      try {
        const userId = userIdFromRequest(request, store);
        // The personal workspace is the user's unified history view. Other
        // project tabs remain scoped to their own threads.
        const ownedThreadIds = store.ownedThreadIds(
          userId,
          isUserWorkspaceProject(project, userId) ? undefined : project.id
        );
        const searchTerm = normalizeSearchTerm(request.query.search);
        if (searchTerm) {
          return {
            data: await searchOwnedThreadList(bridge, ownedThreadIds, searchTerm),
            nextCursor: null,
            backwardsCursor: null
          };
        }
        const result = await listAllCodexThreads(bridge, {
          // Query global summaries, then strictly filter by per-user ownership.
          // This includes historical sessions whose cwd predates the workspace move.
          limit: THREAD_LIST_PAGE_SIZE,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived: request.query.archived === "true",
          // Empty string forces app-server to scan and repair JSONL metadata; null can miss recent cwd-matched threads.
          // We do fuzzy matching after ownership filtering so app-server search cannot hide owned threads unexpectedly.
          searchTerm: "",
          useStateDbOnly: false
        });
        return {
          ...result,
          data: await filterOwnedThreadList(bridge, result.data, ownedThreadIds, ""),
          nextCursor: null,
          backwardsCursor: null
        };
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  app.delete<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const project = store.getProject(request.params.id, userId);
    if (!project) {
      return reply.code(404).send({ error: "Project not found." });
    }

    const unusedThread = store.softDeleteThread(
      request.params.threadId,
      userId,
      project.id,
      isUserWorkspaceProject(project, userId)
    );
    if (!unusedThread) {
      return reply.code(404).send({ error: "Thread not found." });
    }
    return { ok: true, data: unusedThread };
  });

  app.post<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/export", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      if (!store.userCanAccessThread(
        request.params.threadId,
        userId,
        isUserWorkspaceProject(project, userId) ? undefined : project.id
      )) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }

      const input = threadExportSchema.parse(request.body ?? {});
      let result: unknown;
      try {
        result = await bridge.request("thread/read", {
          threadId: request.params.threadId,
          includeTurns: true
        });
        result = await readThreadPreferJsonlFallback(request.params.threadId, result);
      } catch (readError) {
        const fallbackPath = threadJsonlPathFromError(readError) ?? await findThreadJsonlPathById(request.params.threadId);
        if (!fallbackPath) {
          throw readError;
        }
        result = sanitizeThreadPayloadForClient(await readThreadFromJsonl(fallbackPath, request.params.threadId));
      }
      result = sanitizeThreadPayloadForClient(result);

      const thread = asRecord(asRecord(result).thread);
      const settings = store.getLocalSendSettings(userId);
      const outputRoot = validateServerOutputPath(input.outputPath, settings);
      const outputDir = path.join(outputRoot, safeFolderSegment(userId, "user"));
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

      const filename = exportFileName(thread, request.params.threadId, input.format);
      const filePath = path.join(outputDir, filename);
      const rendered = renderThreadExport(thread, { name: project.name, rootPath: project.rootPath }, request.params.threadId, input.format);
      fs.writeFileSync(filePath, rendered.content, { mode: 0o600 });
      const stat = fs.statSync(filePath);
      const target = resolveProjectFilePath(project.rootPath, filePath, {
        allowOutsideRoot: serverConfig.allowOutsideProjectRoot
      });
      const sentLocal = input.sendLocal
        ? await sendFileToLocalViaSsh(settingsForCurrentAccessDevice(settings, request), target.filePath, input.destinationPath)
        : undefined;

      return {
        data: {
          name: path.basename(target.filePath),
          path: target.filePath,
          relativePath: target.relativePath,
          size: stat.size,
          mime: rendered.mime,
          rawUrl: rawFileUrl(project.id, target.relativePath),
          format: input.format,
          outputPath: outputDir,
          sentLocal: sentLocal
            ? {
                sourcePath: target.filePath,
                relativePath: target.relativePath,
                name: path.basename(target.filePath),
                size: stat.size,
                ...sentLocal
              }
            : undefined
        }
      };
    } catch (error) {
      return reply.code(errorStatus(error) === 500 ? 502 : errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { threadId: string }; Querystring: { projectId?: string; before?: string; limit?: string } }>("/api/threads/:threadId", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const input = threadReadQuerySchema.parse(request.query ?? {});
      const project = input.projectId ? store.getProject(input.projectId, userId) : null;
      if (input.projectId && !project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      if (!store.userCanAccessThread(
        request.params.threadId,
        userId,
        project && isUserWorkspaceProject(project, userId) ? undefined : project?.id
      )) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }

      let result: unknown;
      // Persisted JSONL is local, paginated and independent of the shared Codex
      // app-server queue. Prefer it for every existing session, not only huge ones.
      const fallbackPath = await findThreadJsonlPathById(request.params.threadId);
      if (fallbackPath) {
        result = await readThreadFromJsonl(fallbackPath, request.params.threadId);
      } else {
        result = await bridge.request("thread/read", {
          threadId: request.params.threadId,
          includeTurns: true
        });
        result = await readThreadPreferJsonlFallback(request.params.threadId, result);
      }
      result = sanitizeThreadPayloadForClient(result);
      const page = paginateThreadPayload(result, input.before, input.limit);
      return page;
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
