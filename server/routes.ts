import fs from "node:fs";
import { overlayJournal } from "./timelineJournal.js";
import { execFile, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CodexBridge } from "./codexBridge.js";
import { isAccountPoolBridge } from "./accountPoolBridge.js";
import { LegacyRollbackConflictError } from "./legacyRollback.js";
import { inheritedBillingTurnIds } from "./leaderboardForkUsage.js";
import { authenticatedUserFromHeaders } from "./auth.js";
import { isLegacyGeneratedBranchPin } from "./branchContext.js";
import { defaults, serverConfig } from "./config.js";
import { createCrossAccountForkSnapshot } from "./crossAccountFork.js";
import { DEFAULT_USER_ID, type ProjectStore, type ThreadPresentation } from "./db.js";
import { listBrowsableDirectories } from "./directoryBrowser.js";
import { isInternalUserMessageText } from "./internalUserMessage.js";
import { isContextCompactionItem, isGenericContextLossReply } from "./contextRecovery.js";
import { ensureProjectDirectory, PathPolicyError, resolveProjectFilePath, resolveProjectPath } from "./pathPolicy.js";
import { findThreadJsonlPathById, paginateThreadPayload, readThreadFromJsonl, readThreadSummaryFromJsonl, threadJsonlMatchesSearch, threadJsonlPathFromError, threadJsonlSessionsRoot } from "./threadFallback.js";
import { isProjectLocalHook, listHooksForProject } from "./hookTrust.js";
import { assertRepositoryWithinProject, createManagedWorktree, discoverGitRepositories, removeManagedWorktree } from "./worktree.js";
import { locateIndexedThreadItem, readIndexedThreadItem, readIndexedThreadPage, warmThreadIndex } from "./threadEventIndex.js";
import { searchChatThreadHits, searchChatThreads, startChatSearch } from "./chatSearch.js";
import { listAllCodexThreads, THREAD_LIST_PAGE_SIZE } from "./threadList.js";
import {
  contextPinDeveloperInstructions,
  contextWindowMeasuredForConfig,
  defaultThreadContextConfig,
  readThreadContextUsage,
  resolveThreadContextConfig,
  ThreadContextConfigError,
  threadContextFeatureEnabled,
  threadContextConfigOverrides,
  threadTurnContextConfigOverrides
} from "./threadContext.js";
import { importStagedUserHandoff, type ImportedUserHandoff } from "./userHandoff.js";
import { pushPublicKey } from "./webPush.js";
import { advanceTrackedQuotaLedger, type TrackedQuotaLedgerAccount } from "./trackedQuotaLedger.js";
import { configuredSubagentRuntimeHomes, findSubagentDescendant, readSubagentDirectoryPage } from "./subagentHistory.js";

const execFileAsync = promisify(execFile);
const uploadRoot = process.env.CODEX_WEB_UPLOAD_TMP_DIR ?? "/tmp/codex_remote_uploads";
// Default Codex cwd per logged-in user. This prevents generated artifacts from
// accumulating in /home/<user> while retaining historical shared-home projects.
const userWorkspaceRoot = process.env.CODEX_WEB_USER_WORKSPACE_ROOT ?? path.join(serverConfig.dataDir, "users");
const maxPreviewBytes = 2 * 1024 * 1024;
const defaultThreadHistoryPageSize = 120;
const maxThreadHistoryPageSize = 240;
const handoffInFlightUsers = new Set<string>();
type HandoffJobPhase = "connecting" | "transferring" | "extracting" | "importing" | "completed" | "failed";
type HandoffImportResult = Awaited<ReturnType<typeof importStagedUserHandoff>>;
interface HandoffJob {
  id: string;
  userId: string;
  status: "running" | "completed" | "failed";
  phase: HandoffJobPhase;
  bytesTransferred: number;
  startedAt: string;
  updatedAt: string;
  result?: HandoffImportResult;
  message?: string;
  error?: string;
}
const handoffJobs = new Map<string, HandoffJob>();
const handoffJobIdsByUser = new Map<string, string>();
const handoffSourceSchema = z.object({
  sourceHost: z.string().trim().max(255).optional(),
  sourceUser: z.string().trim().max(64).optional(),
  sourceAppDir: z.string().trim().max(512).optional(),
  sourceLabel: z.string().trim().max(96).optional()
});

interface HandoffSourceSettings {
  host: string;
  user: string;
  appDir: string;
  label: string;
}

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
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".mjs",
  ".mmd",
  ".mermaid",
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
const videoExtensions = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".mmd": "text/plain; charset=utf-8",
  ".mermaid": "text/plain; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mdx": "text/markdown; charset=utf-8",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".toml": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".webm": "video/webm",
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
const createWorktreeSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), repositoryPath: z.string().min(1).max(4096).optional() });

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

const threadBranchSchema = z.object({
  turnId: z.string().trim().min(1).max(256),
  prompt: z.string().trim().max(24_000).optional().default(""),
  targetProjectId: z.string().uuid().optional()
});

const threadReadQuerySchema = z.object({
  projectId: z.string().optional(),
  before: z.coerce.number().int().min(0).optional().default(0),
  cursor: z.string().max(512).optional(),
  fresh: z.enum(["1", "true"]).optional().transform((value) => value === "1" || value === "true"),
  limit: z.coerce.number().int().min(1).max(maxThreadHistoryPageSize).optional().default(defaultThreadHistoryPageSize)
});

const threadPresentationSchema = z.object({
  pinned: z.boolean()
});

const threadContextPinSchema = z.object({
  text: z.string().max(16_000)
}).strict();

const threadContextConfigSchema = z.object({
  profile: z.enum(["default", "balanced", "long", "maximum", "custom"]),
  contextWindow: z.number().int().nullable().optional(),
  compactTokenLimit: z.number().int().nullable().optional(),
  scope: z.enum(["total", "body_after_prefix"]).nullable().optional()
}).strict();

const threadModelProfileSchema = z.object({
  model: z.string().trim().min(1).max(128),
  reasoningEffort: effortSchema
}).strict();

const threadOrderSchema = z.object({
  threadIds: z.array(z.string().trim().min(1).max(256)).min(1).max(500)
}).superRefine((value, context) => {
  if (new Set(value.threadIds).size !== value.threadIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "threadIds must not contain duplicates" });
  }
});

const fallbackCodexModels: Array<{
  slug: string;
  displayName: string;
  priority: number;
  efforts: ReasoningEffort[];
}> = [
  { slug: "gpt-6-astra", displayName: "GPT-6-Astra", priority: 1, efforts: ["ultra", "max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", priority: 1.5, efforts: ["max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-6-sol", displayName: "GPT-6-Sol", priority: 2, efforts: ["ultra", "max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-6-luna", displayName: "GPT-6-Luna", priority: 3, efforts: ["max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", priority: 4, efforts: ["ultra", "max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", priority: 7, efforts: ["ultra", "max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", priority: 8, efforts: ["max", "xhigh", "high", "medium", "low"] },
  { slug: "gpt-5.5", displayName: "GPT-5.5", priority: 12, efforts: ["xhigh", "high", "medium", "low"] }
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

const hiddenChatGptCodexModels = new Set([
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini"
]);

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
  // Keep accepting `ultra` on existing/persisted threads for backwards
  // compatibility, but do not advertise it as a selectable UI profile.
  return efforts.filter((effort) => effort !== "ultra").map((effort) => ({
    id: `${model.slug}:${effort}`,
    label: `${model.displayName} ${effort}`,
    model: model.slug,
    effort,
    displayName: model.displayName,
    priority: model.priority
  }));
}

function fallbackModelProfiles(): PublicModelProfile[] {
  return fallbackCodexModels.flatMap((model) => profilesForModel(model, model.efforts));
}

export function modelProfilesFromCatalog(catalog: unknown): PublicModelProfile[] {
  const models = Array.isArray(asRecord(catalog).models) ? (asRecord(catalog).models as unknown[]) : [];
  const profiles = models.flatMap((entry) => {
    const record = asRecord(entry);
    const slug = typeof record.slug === "string" ? record.slug.trim() : "";
    const displayName = typeof record.display_name === "string" ? record.display_name.trim() : slug;
    const visibility = typeof record.visibility === "string" ? record.visibility : "";
    const shellType = typeof record.shell_type === "string" ? record.shell_type : "";
    // Codex requires integer priorities in its catalog. Keep the web picker
    // ordering independent so GPT-6.1 Sol stays between Astra and Sol.
    const priority = slug === "gpt-6.1-sol"
      ? 1.5
      : typeof record.priority === "number" ? record.priority : 999;
    // Codex 0.153 switched current models (including GPT-6 Astra) from the
    // legacy shell_command transport to unified_exec.  Both transports are
    // valid model-picker entries; rejecting the newer value silently replaced
    // the whole live catalog with our stale fallback list.
    if (
      !slug
      || hiddenChatGptCodexModels.has(slug)
      || visibility !== "list"
      || (shellType !== "shell_command" && shellType !== "unified_exec")
    ) {
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
    const debugArgs = ["debug", "models"];
    const configuredCodexHome = process.env.CODEX_HOME?.trim();
    if (configuredCodexHome) {
      const configuredCatalog = path.join(configuredCodexHome, "model-catalog-gpt-5.6-sol-long-context.json");
      if (fs.existsSync(configuredCatalog)) {
        // Codex 0.153 does not consistently apply model_catalog_json from the
        // config file to `debug models`; pass the same catalog explicitly that
        // the account-pool app-server processes use.
        debugArgs.push("-c", `model_catalog_json=${JSON.stringify(configuredCatalog)}`);
      }
    }
    const stdout = execFileSync(serverConfig.codexBin, debugArgs, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env
    });
    const profiles = modelProfilesFromCatalog(JSON.parse(stdout));
    for (const catalogPath of (process.env.CODEX_WEB_EXTRA_MODEL_CATALOGS ?? "").split(path.delimiter).filter(Boolean)) {
      try {
        profiles.push(...modelProfilesFromCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf8"))));
      } catch (error) {
        console.warn(`Unable to read extra model catalog ${catalogPath}:`, error);
      }
    }
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
const codexQuotaCacheTtlMs = 180_000;
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
  // Let Codex refresh an expired access token before quota requests use it.
  const [accountSettled] = await Promise.allSettled([
    bridge.request("account/read", { refreshToken: true }, 30_000)
  ]);
  const [limitsSettled, usageSettled] = await Promise.allSettled([
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
  if (isAccountPoolBridge(bridge)) {
    // Legacy clients still use /quota. Route them through the pool's same
    // single-flight and native-owned auth instead of forcing a separate OAuth
    // refresh or assembling account/limits/usage from different accounts.
    const snapshots = await bridge.refreshAccountData(forceRefresh);
    const selected = snapshots.find(entry => entry.selectedForNewThreads && entry.kind !== "api-provider")
      ?? snapshots.find(entry => entry.kind !== "api-provider");
    if (!selected) throw new Error("No OpenAI account is available for quota details.");
    return sanitizeCodexQuota(selected.account, selected.limits, selected.usage, selected.errors);
  }
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

export function sanitizeMcpServerStatus(result: unknown) {
  const root = asRecord(result);
  const entries = Array.isArray(root.data) ? root.data : [];
  return {
    data: entries.slice(0, 100).map((entry) => {
      const server = asRecord(entry);
      return {
        name: typeof server.name === "string" ? server.name.slice(0, 128) : "未命名 MCP",
        pluginId: typeof server.pluginId === "string" ? server.pluginId.slice(0, 128) : null,
        runtimeStatus: typeof server.runtimeStatus === "string" ? server.runtimeStatus : null,
        authStatus: typeof server.authStatus === "string" ? server.authStatus : "unknown",
        toolCount: Object.keys(asRecord(server.tools)).length
      };
    }),
    nextCursor: typeof root.nextCursor === "string" ? root.nextCursor : null,
    sharedRuntimeWarning: "Codex 额度账号运行时由多人共享；此处只显示状态，不开放外部账号授权。"
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
  resetWindowMins: number | null;
  startAt: number | null;
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

type LeaderboardFileUsage = TokenAccumulator & {
  userId: string;
  sessionId: string;
  model: string;
  effort: string | null;
  resetAt: number | null;
  occurredAt?: number | null;
  dayKey?: string | null;
};

type LeaderboardFileSummary = {
  size: number;
  mtimeMs: number;
  startAt: number | null;
  usage: LeaderboardFileUsage[];
  granularity?: "day" | "event";
  billingVersion?: number;
};

type LeaderboardFileCachePayload = {
  version: 1;
  files: Record<string, LeaderboardFileSummary>;
};

type LeaderboardAccountSource = {
  id: string;
  label: string;
  kind: "codex-account" | "api-provider";
  sessionsRoot: string;
  quota: PublicCodexQuota;
};

type LeaderboardCycleWindow = {
  startAt: number;
  resetAt: number | null;
  resetWindowMins: number | null;
};

// Quota snapshots from parallel Codex processes can differ by seconds (and
// occasionally a few minutes) while still referring to the same weekly cycle.
// Do not use the JSONL timestamp alone for GPT: imported rollouts may stamp
// old usage with the import time, making historical tokens look current.
const leaderboardResetDriftSeconds = 5 * 60;

export type PublicTrackedQuotaDayAccount = {
  accountId: string;
  accountLabel: string;
  userTokens: number;
  quotaPercent: number;
};

export type PublicTrackedQuotaDay = {
  date: string;
  userTokens: number;
  quotaPercent: number;
  accounts: PublicTrackedQuotaDayAccount[];
};

export type PublicTrackedQuotaAccount = {
  accountId: string;
  accountLabel: string;
  cycleStartAt: number | null;
  resetAt: number | null;
  accountUsedPercent: number | null;
  accountRemainingPercent: number | null;
  userCycleTokens: number;
  userCycleQuotaPercent: number;
  todayTokens: number;
  todayQuotaPercent: number;
};

export type PublicTrackedQuotaUsage = {
  userId: string;
  timeZone: string;
  today: string;
  dailyLimitPercent: number;
  unlimitedAccountId: string | null;
  todayQuotaPercent: number;
  blocked: boolean;
  accounts: PublicTrackedQuotaAccount[];
  days: PublicTrackedQuotaDay[];
  updatedAt: string;
  errors: string[];
};

const leaderboardCacheTtlMs = 60_000;
const leaderboardFileCachePath = path.join(serverConfig.dataDir, "leaderboard-file-cache.json");
let leaderboardCache: { data: PublicCodexLeaderboard; expiresAt: number; resetKey: string } | null = null;
let leaderboardRefreshInFlight: Promise<PublicCodexLeaderboard> | null = null;
let leaderboardFileCacheLoaded = false;
const leaderboardFileCache = new Map<string, LeaderboardFileSummary>();
let trackedQuotaCache: { data: PublicTrackedQuotaUsage; expiresAt: number } | null = null;
let trackedQuotaRefreshInFlight: Promise<PublicTrackedQuotaUsage> | null = null;
let trackedQuotaDiskCacheLoaded = false;
const trackedQuotaCacheTtlMs = 60_000;
const trackedQuotaCachePath = path.join(serverConfig.dataDir, "tracked-quota-cache.json");
const trackedQuotaLedgerPath = path.join(serverConfig.dataDir, "tracked-quota-ledger.json");

function readTrackedQuotaLedger(): Record<string, TrackedQuotaLedgerAccount> {
  try {
    const payload = JSON.parse(fs.readFileSync(trackedQuotaLedgerPath, "utf8")) as {
      version?: number;
      userId?: string;
      accounts?: Record<string, TrackedQuotaLedgerAccount>;
    };
    if (payload.version !== 1 || payload.userId !== serverConfig.trackedQuotaUser || !payload.accounts) return {};
    return payload.accounts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Unable to read tracked quota ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {};
  }
}

function persistTrackedQuotaLedger(accounts: Record<string, TrackedQuotaLedgerAccount>): void {
  fs.mkdirSync(path.dirname(trackedQuotaLedgerPath), { recursive: true, mode: 0o700 });
  const temporary = `${trackedQuotaLedgerPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, userId: serverConfig.trackedQuotaUser, accounts }), { mode: 0o600 });
  fs.renameSync(temporary, trackedQuotaLedgerPath);
}

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

function naturalDayKey(timestampSeconds: number, timeZone = serverConfig.trackedQuotaTimeZone): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestampSeconds * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function estimatedQuotaPercent(userTokens: number, totalTokens: number, accountUsedPercent: number | null): number {
  if (userTokens <= 0 || totalTokens <= 0 || accountUsedPercent === null || !Number.isFinite(accountUsedPercent)) return 0;
  return round2((userTokens / totalTokens) * accountUsedPercent) ?? 0;
}

function loadTrackedQuotaDiskCache(): void {
  if (trackedQuotaDiskCacheLoaded) return;
  trackedQuotaDiskCacheLoaded = true;
  try {
    const data = JSON.parse(fs.readFileSync(trackedQuotaCachePath, "utf8")) as PublicTrackedQuotaUsage;
    const today = naturalDayKey(Math.floor(Date.now() / 1000));
    if (
      data?.today === today
      && data.userId === serverConfig.trackedQuotaUser
      && data.timeZone === serverConfig.trackedQuotaTimeZone
      && data.dailyLimitPercent === serverConfig.trackedQuotaDailyLimitPercent
      && data.unlimitedAccountId === (serverConfig.trackedQuotaAllowedAccountId || null)
      && Array.isArray(data.accounts)
      && Array.isArray(data.days)
    ) {
      // Return the last complete snapshot immediately after a process restart,
      // then refresh it in the background on the first request.
      trackedQuotaCache = { data, expiresAt: 0 };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Unable to read tracked quota cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function persistTrackedQuotaDiskCache(data: PublicTrackedQuotaUsage): void {
  fs.mkdirSync(path.dirname(trackedQuotaCachePath), { recursive: true, mode: 0o700 });
  const temporary = `${trackedQuotaCachePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(temporary, trackedQuotaCachePath);
}

function loadLeaderboardFileCache(): void {
  if (leaderboardFileCacheLoaded) return;
  leaderboardFileCacheLoaded = true;
  try {
    const payload = JSON.parse(fs.readFileSync(leaderboardFileCachePath, "utf8")) as LeaderboardFileCachePayload;
    if (payload.version !== 1 || !payload.files || typeof payload.files !== "object") return;
    for (const [filePath, summary] of Object.entries(payload.files)) {
      if (summary && Number.isFinite(summary.size) && Number.isFinite(summary.mtimeMs) && Array.isArray(summary.usage)) {
        leaderboardFileCache.set(filePath, summary);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Unable to read leaderboard cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function persistLeaderboardFileCache(): void {
  fs.mkdirSync(path.dirname(leaderboardFileCachePath), { recursive: true, mode: 0o700 });
  const temporary = `${leaderboardFileCachePath}.${process.pid}.tmp`;
  const payload: LeaderboardFileCachePayload = {
    version: 1,
    files: Object.fromEntries(leaderboardFileCache)
  };
  fs.writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(temporary, leaderboardFileCachePath);
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

export function userIdFromSessionCwd(cwd: string | null, isKnownUser?: (userId: string) => boolean): string | null {
  if (!cwd) {
    return null;
  }
  const normalizedRoot = path.resolve(userWorkspaceRoot);
  const normalizedCwd = path.resolve(cwd);
  if (normalizedCwd.startsWith(`${normalizedRoot}${path.sep}`)) {
    const [firstSegment] = path.relative(normalizedRoot, normalizedCwd).split(path.sep);
    return firstSegment?.trim() || null;
  }
  // Some existing users run Codex directly in /home/<login> rather than
  // the managed users root. Only trust this layout for a registered login.
  const homeRoot = path.dirname(path.dirname(normalizedRoot));
  if (isKnownUser && normalizedCwd.startsWith(`${homeRoot}${path.sep}`)) {
    const [firstSegment] = path.relative(homeRoot, normalizedCwd).split(path.sep);
    if (firstSegment && isKnownUser(firstSegment)) return firstSegment;
  }
  return null;
}

function sessionMetadataFromFileStart(filePath: string): Record<string, unknown> | null {
  const buffer = Buffer.alloc(64 * 1024);
  const fd = fs.openSync(filePath, "r");
  try {
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytes).split("\n", 1)[0];
    const record = JSON.parse(firstLine) as { type?: string; payload?: Record<string, unknown> };
    return record.type === "session_meta" ? record.payload ?? null : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function sessionCwdFromFileStart(filePath: string): string | null {
  return stringOrNull(sessionMetadataFromFileStart(filePath)?.cwd);
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
  options: { totalQuotaUsedPercent: number | null; resetAt: number | null; resetWindowMins: number | null; startAt?: number | null }
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
    resetWindowMins: options.resetWindowMins,
    startAt: options.startAt !== undefined
      ? options.startAt
      : options.resetAt !== null && options.resetWindowMins !== null && options.resetWindowMins > 0
        ? options.resetAt - options.resetWindowMins * 60
        : null,
    quotaUsedPercent: options.totalQuotaUsedPercent,
    users
  };
}

function sharedNumericValue(values: Array<number | null>): number | null {
  const normalized = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!normalized.length) {
    return null;
  }
  const first = normalized[0];
  return normalized.every((value) => value === first) ? first : null;
}

function numericBoundary(values: Array<number | null>, direction: "min" | "max"): number | null {
  const normalized = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!normalized.length) {
    return null;
  }
  return direction === "min" ? Math.min(...normalized) : Math.max(...normalized);
}

function mergeLeaderboardScopes(
  scopes: PublicLeaderboardScope[],
  accountLabels: string[],
  separateAccounts = true,
  combinedQuotaUsedPercent: number | null = null
): PublicLeaderboardScope {
  const buckets = new Map<string, AggregateBucket>();
  for (const [scopeIndex, scope] of scopes.entries()) {
    const accountLabel = accountLabels[scopeIndex] || `账号 ${scopeIndex + 1}`;
    for (const user of scope.users) {
      // The same Web login can use both purchased Codex accounts.  Keep those
      // rows separate instead of silently folding account two into account one.
      const displayUserId = separateAccounts ? `${user.userId} · ${accountLabel}` : user.userId;
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
  return finalizeLeaderboardScope(
    buckets,
    {
      totalQuotaUsedPercent: combinedQuotaUsedPercent,
      resetAt: numericBoundary(scopes.map((scope) => scope.resetAt), "max"),
      resetWindowMins: sharedNumericValue(scopes.map((scope) => scope.resetWindowMins)),
      startAt: numericBoundary(scopes.map((scope) => scope.startAt), "min")
    }
  );
}

/** API plans have no Codex quota reset; rank them over the same visible GPT window. */
export function apiLeaderboardCycleWindow(
  cycles: Array<{ resetAt: number | null; resetWindowMins: number | null }>,
  nowSeconds: number
): LeaderboardCycleWindow {
  const valid = cycles.flatMap(({ resetAt, resetWindowMins }) =>
    resetAt !== null && resetWindowMins !== null && resetWindowMins > 0
      ? [{ startAt: resetAt - resetWindowMins * 60, resetAt }]
      : []
  );
  return valid.length
    ? {
        startAt: Math.min(...valid.map((cycle) => cycle.startAt)),
        resetAt: Math.max(...valid.map((cycle) => cycle.resetAt)),
        resetWindowMins: null
      }
    : { startAt: nowSeconds - 7 * 24 * 60 * 60, resetAt: null, resetWindowMins: null };
}

export function usageInLeaderboardCycle(
  usage: { resetAt: number | null; occurredAt?: number | null },
  sourceKind: LeaderboardAccountSource["kind"],
  window: LeaderboardCycleWindow
): boolean {
  if (sourceKind !== "api-provider") {
    return window.resetAt !== null && usage.resetAt !== null
      && Math.abs(usage.resetAt - window.resetAt) <= leaderboardResetDriftSeconds;
  }
  return usage.occurredAt !== null && usage.occurredAt !== undefined
    && usage.occurredAt >= window.startAt
    && (window.resetAt === null || usage.occurredAt < window.resetAt);
}

export function mergeAccountLeaderboards(boards: PublicCodexLeaderboard[], sources: LeaderboardAccountSource[]): PublicCodexLeaderboard {
  const codexBoards = boards.filter((_, index) => sources[index]?.kind !== "api-provider");
  const quotaByUser = new Map<string, number>();
  for (const board of codexBoards) {
    for (const user of board.currentCycle.users) {
      if (user.quotaPercent !== null) quotaByUser.set(user.userId, (quotaByUser.get(user.userId) ?? 0) + user.quotaPercent);
    }
  }
  const currentCycle = mergeLeaderboardScopes(
    boards.map((board) => board.currentCycle),
    boards.map((_, index) => `账号 ${index + 1}`),
    false,
    codexBoards.some((board) => board.currentCycle.quotaUsedPercent !== null)
      ? codexBoards.reduce((sum, board) => sum + (board.currentCycle.quotaUsedPercent ?? 0), 0)
      : null
  );
  // API tokens affect token rank/share, never a user's estimated GPT quota.
  currentCycle.users = currentCycle.users.map((user) => ({ ...user, quotaPercent: quotaByUser.get(user.userId) ?? null }));
  return {
    currentCycle,
    lifetime: mergeLeaderboardScopes(
      boards.map((board) => board.lifetime),
      boards.map((_, index) => `账号 ${index + 1}`),
      false
    ),
    updatedAt: new Date().toISOString(),
    errors: boards.flatMap((board) => board.errors)
  };
}

/** The leaderboard and quota panel must show the same accrued estimate;
 * dividing again by other users' tokens would dilute previously assigned use. */
export function applyAccruedTrackedQuota(
  board: PublicCodexLeaderboard,
  sources: LeaderboardAccountSource[],
  ledger: Record<string, TrackedQuotaLedgerAccount>,
  userId: string
): PublicCodexLeaderboard {
  const matched = sources.filter(source => source.kind !== "api-provider" && ledger[source.id]
    && source.quota.rateLimits?.primary?.resetsAt != null
    && Math.abs(ledger[source.id].resetAt - source.quota.rateLimits.primary.resetsAt) <= leaderboardResetDriftSeconds);
  if (!matched.length) return board;
  const accrued = round2(matched.reduce((sum, source) => sum + ledger[source.id].userCycleQuotaPercent, 0));
  return { ...board, currentCycle: { ...board.currentCycle, users: board.currentCycle.users.map(user =>
    sameTrackedUser(user.userId, userId) ? { ...user, quotaPercent: accrued } : user) } };
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

export async function summarizeLeaderboardFile(
  filePath: string,
  store: ProjectStore,
  resolveSessionOwner: (sessionId: string) => string | null,
  preciseTimestamps = false
): Promise<LeaderboardFileSummary> {
  const stat = fs.statSync(filePath);
  const usageByKey = new Map<string, LeaderboardFileUsage>();
  let sessionId = path.basename(filePath, ".jsonl");
  let userId: string | null = null;
  let model = "unknown";
  let effort: string | null = null;
  let startAt: number | null = null;
  let tokenEventIndex = 0;
  let currentTurnId: string | null = null;
  let inheritedTurns = new Set<string>();
  const knownUsers = new Map<string, boolean>();
  const isKnownUser = (id: string): boolean => {
    if (!knownUsers.has(id)) knownUsers.set(id, store.getUser(id) !== null);
    return knownUsers.get(id)!;
  };
  const input = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 256 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
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
      userId = userId ?? resolveSessionOwner(sessionId) ?? userIdFromSessionCwd(stringOrNull(payload.cwd), isKnownUser);
      const parentId = stringOrNull(payload.forked_from_id);
      if (parentId && parentId !== sessionId) {
        const parentPath = await findThreadJsonlPathById(parentId);
        if (!parentPath) throw new Error(`分支来源 ${parentId} 的日志不可用，不能可靠去除继承用量。`);
        inheritedTurns = await inheritedBillingTurnIds(parentPath);
      }
      continue;
    }
    if (type === "turn_context") {
      currentTurnId = stringOrNull(payload.turn_id) ?? currentTurnId;
      userId = userId ?? resolveSessionOwner(sessionId) ?? userIdFromSessionCwd(stringOrNull(payload.cwd), isKnownUser);
      model = stringOrNull(payload.model) ?? model;
      effort = stringOrNull(payload.effort)
        ?? stringOrNull(asRecord(asRecord(payload.collaboration_mode).settings).reasoning_effort)
        ?? effort;
      continue;
    }
    if (type === "event_msg" && payload.type === "task_started") {
      currentTurnId = stringOrNull(payload.turn_id) ?? currentTurnId;
    }
    if (type !== "event_msg" || stringOrNull(payload.type) !== "token_count") continue;
    if (currentTurnId && inheritedTurns.has(currentTurnId)) continue;

    const recordTimestamp = stringOrNull(record.timestamp);
    const parsedTimestampMs = recordTimestamp ? Date.parse(recordTimestamp) : Number.NaN;
    const occurredAt = Number.isFinite(parsedTimestampMs) ? Math.floor(parsedTimestampMs / 1000) : null;
    const dayKey = occurredAt === null ? null : naturalDayKey(occurredAt);
    if (Number.isFinite(parsedTimestampMs)) {
      const parsedTimestamp = occurredAt!;
      startAt = startAt === null ? parsedTimestamp : Math.min(startAt, parsedTimestamp);
    }
    if (!userId) {
      userId = resolveSessionOwner(sessionId) ?? userIdFromSessionCwd(stringOrNull(payload.cwd), isKnownUser) ?? "unknown";
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
    if (!usage.totalTokens) continue;
    const primary = asRecord(asRecord(payload.rate_limits).primary);
    const resetAt = safeCount(primary.resets_at) ?? safeCount(primary.resetsAt);
    const key = JSON.stringify([userId, sessionId, model, effort, resetAt, dayKey, preciseTimestamps ? tokenEventIndex++ : null]);
    const existing = usageByKey.get(key);
    if (existing) {
      addTokenAccumulator(existing, usage);
      existing.occurredAt = existing.occurredAt === null || existing.occurredAt === undefined
        ? occurredAt
        : occurredAt === null
          ? existing.occurredAt
          : Math.min(existing.occurredAt, occurredAt);
    } else {
      usageByKey.set(key, { userId, sessionId, model, effort, resetAt, occurredAt, dayKey, ...usage });
    }
  }

  return { size: stat.size, mtimeMs: stat.mtimeMs, startAt, usage: Array.from(usageByKey.values()), granularity: preciseTimestamps ? "event" : "day", billingVersion: 2 };
}

async function readCodexLeaderboard(
  source: LeaderboardAccountSource,
  store: ProjectStore,
  apiCycleWindow?: LeaderboardCycleWindow,
  requireDailyBreakdown = false
): Promise<PublicCodexLeaderboard> {
  loadLeaderboardFileCache();
  const files = walkJsonlFiles(source.sessionsRoot);
  const currentQuota = source.quota;
  const currentResetAt = source.kind === "api-provider" ? apiCycleWindow?.resetAt ?? null : currentQuota.rateLimits?.primary?.resetsAt ?? null;
  const currentResetWindowMins = source.kind === "api-provider" ? null : currentQuota.rateLimits?.primary?.windowDurationMins ?? null;
  const currentQuotaUsedPercent = source.kind === "api-provider" ? null : currentQuota.rateLimits?.primary?.usedPercent ?? null;
  const currentCycleStartAt = source.kind === "api-provider"
    ? apiCycleWindow?.startAt ?? Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
    : currentResetAt !== null && currentResetWindowMins !== null && currentResetWindowMins > 0
      ? currentResetAt - currentResetWindowMins * 60
      : null;
  const cycleWindow = currentCycleStartAt === null ? null : {
    startAt: currentCycleStartAt,
    resetAt: currentResetAt,
    resetWindowMins: currentResetWindowMins
  };
  const lifetime = new Map<string, AggregateBucket>();
  const currentCycle = new Map<string, AggregateBucket>();
  const errors: string[] = [];
  const ownerUserCache = new Map<string, string | null>();
  let lifetimeStartAt: number | null = null;

  const resolveSessionOwner = (sessionId: string): string | null => {
    if (ownerUserCache.has(sessionId)) {
      return ownerUserCache.get(sessionId) ?? null;
    }
    const owner = store.getThreadOwner(sessionId);
    const userId = owner?.userId?.trim() || null;
    ownerUserCache.set(sessionId, userId);
    return userId;
  };

  let cacheChanged = false;
  const liveFiles = new Set(files);
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      let summary = leaderboardFileCache.get(filePath);
      if (summary && summary.billingVersion !== 2 && !sessionMetadataFromFileStart(filePath)?.forked_from_id) {
        // Existing non-fork summaries remain valid: avoid reparsing the full
        // historical corpus merely to correct copied fork records.
        summary.billingVersion = 2;
        cacheChanged = true;
      }
      const needsCurrentCycleDailyBreakdown = requireDailyBreakdown && Boolean(
        summary
        && currentCycleStartAt !== null
        && stat.mtimeMs >= currentCycleStartAt * 1000
        && summary.usage.some((entry) => entry.dayKey === undefined)
      );
      const needsEventTimestamps = source.kind === "api-provider" && summary?.granularity !== "event";
      if (!summary || summary.billingVersion !== 2 || summary.size !== stat.size || summary.mtimeMs !== stat.mtimeMs || needsCurrentCycleDailyBreakdown || needsEventTimestamps) {
        summary = await summarizeLeaderboardFile(filePath, store, resolveSessionOwner, source.kind === "api-provider");
        leaderboardFileCache.set(filePath, summary);
        cacheChanged = true;
      }
      if (summary.usage.some((entry) => entry.userId === "unknown")) {
        const cwdUser = userIdFromSessionCwd(sessionCwdFromFileStart(filePath), (id) => store.getUser(id) !== null);
        if (cwdUser) {
          for (const entry of summary.usage) {
            if (entry.userId === "unknown") entry.userId = cwdUser;
          }
          cacheChanged = true;
        }
      }
      if (summary.startAt !== null) {
        lifetimeStartAt = lifetimeStartAt === null ? summary.startAt : Math.min(lifetimeStartAt, summary.startAt);
      }
      for (const entry of summary.usage) {
        const owner = resolveSessionOwner(entry.sessionId) ?? entry.userId;
        recordUsage(lifetime, owner, entry.sessionId, entry.model, entry.effort, entry);
        if (cycleWindow && usageInLeaderboardCycle(entry, source.kind, cycleWindow)) {
          recordUsage(currentCycle, owner, entry.sessionId, entry.model, entry.effort, entry);
        }
      }
    } catch (error) {
      errors.push(`${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const cachedPath of leaderboardFileCache.keys()) {
    if (cachedPath.startsWith(`${source.sessionsRoot}${path.sep}`) && !liveFiles.has(cachedPath)) {
      leaderboardFileCache.delete(cachedPath);
      cacheChanged = true;
    }
  }
  if (cacheChanged) persistLeaderboardFileCache();

  return {
    currentCycle: finalizeLeaderboardScope(currentCycle, {
      totalQuotaUsedPercent: currentQuotaUsedPercent,
      resetAt: currentResetAt,
      resetWindowMins: currentResetWindowMins,
      startAt: currentCycleStartAt
    }),
    lifetime: finalizeLeaderboardScope(lifetime, {
      totalQuotaUsedPercent: null,
      resetAt: null,
      resetWindowMins: null,
      startAt: lifetimeStartAt
    }),
    updatedAt: new Date().toISOString(),
    errors
  };
}

async function readCachedCodexLeaderboard(
  sources: LeaderboardAccountSource[],
  store: ProjectStore,
  forceRefresh = false,
  includePeers = true
): Promise<PublicCodexLeaderboard> {
  const now = Date.now();
  const resetKey = sources.map((source) => `${source.id}:${source.quota.rateLimits?.primary?.resetsAt ?? "none"}`).join("|");
  if (!forceRefresh && leaderboardCache && leaderboardCache.expiresAt > now && leaderboardCache.resetKey === resetKey) {
    return leaderboardCache.data;
  }
  if (leaderboardRefreshInFlight) {
    return leaderboardRefreshInFlight;
  }
  const refresh = (async () => {
    const apiCycleWindow = apiLeaderboardCycleWindow(
      sources.filter((source) => source.kind !== "api-provider").map((source) => ({
        resetAt: source.quota.rateLimits?.primary?.resetsAt ?? null,
        resetWindowMins: source.quota.rateLimits?.primary?.windowDurationMins ?? null
      })),
      Math.floor(Date.now() / 1000)
    );
    const boards: PublicCodexLeaderboard[] = [];
    for (const source of sources) boards.push(await readCodexLeaderboard(source, store, apiCycleWindow));
    const local = boards.length === 1 ? boards[0] : mergeAccountLeaderboards(boards, sources);
    return applyAccruedTrackedQuota(local, sources, readTrackedQuotaLedger(), serverConfig.trackedQuotaUser);
  })()
    .then((local) => includePeers ? mergePeerLeaderboards(local) : local)
    .then((data) => {
      leaderboardCache = { data, expiresAt: Date.now() + leaderboardCacheTtlMs, resetKey };
      return data;
    })
    .finally(() => {
      leaderboardRefreshInFlight = null;
    });
  leaderboardRefreshInFlight = refresh;
  return refresh;
}

async function leaderboardAccountSources(bridge: CodexBridge, forceRefresh: boolean): Promise<LeaderboardAccountSource[]> {
  if (isAccountPoolBridge(bridge)) {
    const snapshots = await bridge.refreshAccountData(forceRefresh);
    return snapshots.map((entry) => ({
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      sessionsRoot: path.join(entry.codexHome, "sessions"),
      quota: sanitizeCodexQuota(entry.account, entry.limits, entry.usage, entry.errors)
    }));
  }
  return [{
    id: serverConfig.leaderboardAccountLabel,
    label: serverConfig.leaderboardAccountLabel,
    kind: "codex-account",
    sessionsRoot: path.join(process.env.CODEX_HOME ?? path.join(process.env.HOME ?? process.cwd(), ".codex"), "sessions"),
    quota: await readCachedCodexQuota(bridge, forceRefresh)
  }];
}

function sameTrackedUser(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

export function allowedAccountForUser(userId: string): string | null {
  return serverConfig.trackedQuotaAllowedAccountId && sameTrackedUser(userId, serverConfig.trackedQuotaUser)
    ? serverConfig.trackedQuotaAllowedAccountId
    : null;
}

async function buildTrackedQuotaUsage(
  bridge: CodexBridge,
  store: ProjectStore,
  forceRefresh: boolean
): Promise<PublicTrackedQuotaUsage> {
  const sources = await leaderboardAccountSources(bridge, forceRefresh);
  const today = naturalDayKey(Math.floor(Date.now() / 1000));
  const trackedUser = serverConfig.trackedQuotaUser;
  const accounts: PublicTrackedQuotaAccount[] = [];
  const dayAccounts = new Map<string, PublicTrackedQuotaDayAccount[]>();
  const errors: string[] = [];
  const ledgerAccounts = readTrackedQuotaLedger();
  const previousDisplay = trackedQuotaCache?.data ?? (() => {
    try {
      return JSON.parse(fs.readFileSync(trackedQuotaCachePath, "utf8")) as PublicTrackedQuotaUsage;
    } catch {
      return null;
    }
  })();

  for (const source of sources) {
    const board = await readCodexLeaderboard(source, store, undefined, true);
    errors.push(...board.errors.map((error) => `${source.label}: ${error}`));
    const cycle = board.currentCycle;
    const accountUsedPercent = cycle.quotaUsedPercent;
    const trackedCycle = cycle.users.find((entry) => sameTrackedUser(entry.userId, trackedUser));
    const dailyUserTotals = new Map<string, number>();

    for (const filePath of walkJsonlFiles(source.sessionsRoot)) {
      const summary = leaderboardFileCache.get(filePath);
      if (!summary) continue;
      for (const entry of summary.usage) {
        if (!entry.dayKey || cycle.resetAt === null || entry.resetAt === null || Math.abs(entry.resetAt - cycle.resetAt) > leaderboardResetDriftSeconds) continue;
        if (sameTrackedUser(entry.userId, trackedUser)) {
          dailyUserTotals.set(entry.dayKey, (dailyUserTotals.get(entry.dayKey) ?? 0) + entry.totalTokens);
        }
      }
    }

    const previousLedger = ledgerAccounts[source.id];
    const previousAccount = previousDisplay?.userId === trackedUser
      ? previousDisplay.accounts.find((entry) => entry.accountId === source.id && entry.resetAt === cycle.resetAt)
      : null;
    const initialDailyPercent = Object.fromEntries(
      (previousAccount ? previousDisplay?.days ?? [] : [])
        .map((day) => [day.date, day.accounts.find((entry) => entry.accountId === source.id)?.quotaPercent ?? 0])
    );
    if (cycle.resetAt !== null && accountUsedPercent !== null) {
      ledgerAccounts[source.id] = advanceTrackedQuotaLedger(
        previousLedger ?? null,
        {
          resetAt: cycle.resetAt,
          quotaPercent: accountUsedPercent,
          totalTokens: cycle.totalTokens,
          userTokens: trackedCycle?.totalTokens ?? 0,
          dailyUserTokens: Object.fromEntries(dailyUserTotals),
          observedAt: Date.now()
        },
        {
          cyclePercent: previousAccount?.userCycleQuotaPercent
            ?? estimatedQuotaPercent(trackedCycle?.totalTokens ?? 0, cycle.totalTokens, accountUsedPercent),
          dailyPercent: Object.keys(initialDailyPercent).length
            ? initialDailyPercent
            : Object.fromEntries(Array.from(dailyUserTotals, ([date, tokens]) => [
              date,
              estimatedQuotaPercent(tokens, cycle.totalTokens, accountUsedPercent)
            ]))
        }
      );
    }
    const ledger = ledgerAccounts[source.id]?.resetAt === cycle.resetAt ? ledgerAccounts[source.id] : null;

    for (const [date, userTokens] of dailyUserTotals) {
      const quotaPercent = round2(ledger?.dailyQuotaPercent[date]
        ?? estimatedQuotaPercent(userTokens, cycle.totalTokens, accountUsedPercent)) ?? 0;
      const list = dayAccounts.get(date) ?? [];
      list.push({ accountId: source.id, accountLabel: source.label, userTokens, quotaPercent });
      dayAccounts.set(date, list);
    }

    const todayTokens = dailyUserTotals.get(today) ?? 0;
    accounts.push({
      accountId: source.id,
      accountLabel: source.label,
      cycleStartAt: cycle.startAt,
      resetAt: cycle.resetAt,
      accountUsedPercent,
      accountRemainingPercent: accountUsedPercent === null ? null : round2(Math.max(0, 100 - accountUsedPercent)),
      userCycleTokens: trackedCycle?.totalTokens ?? 0,
      userCycleQuotaPercent: round2(ledger?.userCycleQuotaPercent
        ?? estimatedQuotaPercent(trackedCycle?.totalTokens ?? 0, cycle.totalTokens, accountUsedPercent)) ?? 0,
      todayTokens,
      todayQuotaPercent: round2(ledger?.dailyQuotaPercent[today]
        ?? estimatedQuotaPercent(todayTokens, cycle.totalTokens, accountUsedPercent)) ?? 0
    });
  }

  persistTrackedQuotaLedger(ledgerAccounts);

  const days = Array.from(dayAccounts.entries())
    .map(([date, dayEntries]) => ({
      date,
      userTokens: dayEntries.reduce((sum, entry) => sum + entry.userTokens, 0),
      quotaPercent: round2(dayEntries.reduce((sum, entry) => sum + entry.quotaPercent, 0)) ?? 0,
      accounts: [...dayEntries].sort((left, right) => left.accountLabel.localeCompare(right.accountLabel))
    }))
    .sort((left, right) => right.date.localeCompare(left.date));
  const todayQuotaPercent = round2(accounts.reduce((sum, account) => sum + account.todayQuotaPercent, 0)) ?? 0;
  return {
    userId: trackedUser,
    timeZone: serverConfig.trackedQuotaTimeZone,
    today,
    dailyLimitPercent: serverConfig.trackedQuotaDailyLimitPercent,
    unlimitedAccountId: serverConfig.trackedQuotaAllowedAccountId || null,
    todayQuotaPercent,
    blocked: !serverConfig.trackedQuotaAllowedAccountId && todayQuotaPercent >= serverConfig.trackedQuotaDailyLimitPercent,
    accounts,
    days,
    updatedAt: new Date().toISOString(),
    errors
  };
}

export async function readTrackedQuotaUsage(
  bridge: CodexBridge,
  store: ProjectStore,
  forceRefresh = false
): Promise<PublicTrackedQuotaUsage> {
  loadTrackedQuotaDiskCache();
  const startRefresh = (refreshAccountQuota: boolean) => {
    if (trackedQuotaRefreshInFlight) return trackedQuotaRefreshInFlight;
    trackedQuotaRefreshInFlight = buildTrackedQuotaUsage(bridge, store, refreshAccountQuota)
    .then((data) => {
      trackedQuotaCache = { data, expiresAt: Date.now() + trackedQuotaCacheTtlMs };
      persistTrackedQuotaDiskCache(data);
      return data;
    })
    .finally(() => {
      trackedQuotaRefreshInFlight = null;
    });
    return trackedQuotaRefreshInFlight;
  };
  if (!forceRefresh && trackedQuotaCache) {
    if (trackedQuotaCache.expiresAt <= Date.now()) {
      // Stale-while-revalidate: opening the panel never waits for a JSONL scan.
      void startRefresh(false).catch((error) => {
        console.warn(`Tracked quota background refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    return trackedQuotaCache.data;
  }
  return startRefresh(forceRefresh);
}

export function invalidateTrackedQuotaCacheForUser(userId: string): void {
  if (trackedQuotaCache && sameTrackedUser(userId, serverConfig.trackedQuotaUser)) {
    trackedQuotaCache.expiresAt = 0;
  }
}

async function readTrackedQuotaUsageForEnforcement(
  bridge: CodexBridge,
  store: ProjectStore
): Promise<PublicTrackedQuotaUsage> {
  loadTrackedQuotaDiskCache();
  if (trackedQuotaCache && trackedQuotaCache.expiresAt > Date.now()) return trackedQuotaCache.data;
  if (trackedQuotaRefreshInFlight) return trackedQuotaRefreshInFlight;
  trackedQuotaRefreshInFlight = buildTrackedQuotaUsage(bridge, store, false)
    .then((data) => {
      trackedQuotaCache = { data, expiresAt: Date.now() + trackedQuotaCacheTtlMs };
      persistTrackedQuotaDiskCache(data);
      return data;
    })
    .finally(() => {
      trackedQuotaRefreshInFlight = null;
    });
  return trackedQuotaRefreshInFlight;
}

export async function assertTrackedUserQuotaAvailable(
  bridge: CodexBridge,
  store: ProjectStore,
  userId: string,
  threadId?: string
): Promise<void> {
  if (!serverConfig.trackedQuotaUser || !sameTrackedUser(userId, serverConfig.trackedQuotaUser)) return;
  const allowedAccountId = allowedAccountForUser(userId);
  if (allowedAccountId) {
    if (!isAccountPoolBridge(bridge) || !bridge.hasAccount(allowedAccountId)) {
      throw new Error(`${userId} 的专用账号 ${allowedAccountId} 当前不可用。`);
    }
    if (threadId) {
      const account = await bridge.resolveThreadAccount(threadId);
      if (account.id !== allowedAccountId) {
        throw new Error(`${userId} 只能使用 ${allowedAccountId}；此会话属于 ${account.label}，可查看历史或迁移后继续。`);
      }
    }
    return;
  }
  const usage = await readTrackedQuotaUsageForEnforcement(bridge, store);
  if (usage.blocked) {
    throw new Error(
      `${usage.userId} 今日估算额度占用已达 ${usage.todayQuotaPercent.toFixed(2)}%，超过每日 ${usage.dailyLimitPercent.toFixed(2)}% 上限；今日可查看历史，但不能继续发起回答。`
    );
  }
}

function fileKind(filePath: string): "markdown" | "text" | "image" | "video" | "pdf" | "binary" {
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
  if (videoExtensions.has(extension)) {
    return "video";
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

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

function defaultSshUserForWebUser(userId: string): string {
  const candidate = userId.trim();
  return candidate && !candidate.startsWith("-") && !/[\s@]/.test(candidate) ? candidate : "";
}

function settingsForCurrentAccessDevice(
  settings: ReturnType<ProjectStore["getLocalSendSettings"]>,
  request: { headers: Record<string, unknown>; ip?: string },
  userId: string
): ReturnType<ProjectStore["getLocalSendSettings"]> {
  const savedHost = cleanSshScalar(settings.sshHost, "当前访问设备 SSH 地址");
  const savedUser = cleanSshScalar(settings.sshUser, "SSH 用户");
  const savedDestinationPath = cleanSshScalar(settings.destinationPath, "访问设备保存目录");
  // A user-provided SSH address is deliberate (often a ZeroTier address or a
  // hostname).  It must win over the browser source IP so saved settings are
  // actually used for every transfer.  The source IP remains a convenience
  // fallback only when the user intentionally leaves the setting blank.
  const detected = savedHost ? "" : cleanSshScalar(requestClientHost(request), "当前访问设备 IP");
  return {
    ...settings,
    sshHost: savedHost || detected,
    sshUser: savedUser || defaultSshUserForWebUser(userId),
    destinationPath: savedDestinationPath || "Downloads"
  };
}

function validateLocalSendSettings(settings: ReturnType<ProjectStore["getLocalSendSettings"]>, destinationPathOverride?: string) {
  const sshHost = cleanSshScalar(settings.sshHost, "当前访问设备 SSH 地址");
  const sshUser = cleanSshScalar(settings.sshUser, "SSH 用户");
  const destinationPath = cleanSshScalar(destinationPathOverride ?? settings.destinationPath, "访问设备保存目录");
  const identityFile = cleanSshScalar(settings.identityFile, "私钥路径");
  const sshPort = Math.trunc(settings.sshPort || 22);
  const missing = [
    !sshHost ? "当前访问设备 SSH 地址（或浏览器来源 IP）" : "",
    !sshUser ? "SSH 用户名" : "",
    !destinationPath ? "访问设备保存目录" : ""
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`请先在设置中填写：${missing.join("、")}。`);
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
  // The service SSH agent can contain many unrelated deployment keys. Without
  // this guard Windows OpenSSH may hit MaxAuthTries before the selected/default
  // identity is offered, producing a misleading "Too many authentication
  // failures" even though the host and port are reachable.
  return ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", ...identityOptions, portFlag, String(clean.sshPort)];
}

type RemoteSshShell = "posix" | "windows";

function encodedPowerShellCommand(script: string): string {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

async function detectRemoteSshShell(clean: ReturnType<typeof validateLocalSendSettings>, sshTarget: string): Promise<RemoteSshShell> {
  // Windows OpenSSH can use either PowerShell or cmd.exe as its default shell.
  // Probe both expansion syntaxes before falling back to POSIX.
  const powerShellProbe = await execFileAsync(
    "ssh",
    [...localSshOptions(clean), sshTarget, "echo CODEX_REMOTE_OS=$env:OS"],
    { timeout: 30_000, maxBuffer: 512 * 1024 }
  ).catch(() => ({ stdout: "" }));
  if (powerShellProbe.stdout.includes("CODEX_REMOTE_OS=Windows_NT")) return "windows";
  const cmdProbe = await execFileAsync(
    "ssh",
    [...localSshOptions(clean), sshTarget, "echo CODEX_REMOTE_OS=%OS%"],
    { timeout: 30_000, maxBuffer: 512 * 1024 }
  );
  return cmdProbe.stdout.includes("CODEX_REMOTE_OS=Windows_NT") ? "windows" : "posix";
}

function remoteEnsureDirectoryCommand(remoteShell: RemoteSshShell, directory: string): string {
  if (remoteShell === "windows") {
    const quoted = powershellQuote(directory);
    return encodedPowerShellCommand(`$ProgressPreference='SilentlyContinue'; $codexPath=${quoted}; if (-not (Test-Path -LiteralPath $codexPath)) { New-Item -ItemType Directory -Path $codexPath -Force | Out-Null }`);
  }
  return `mkdir -p -- ${shellQuote(directory)}`;
}

function remoteRemoveFileCommand(remoteShell: RemoteSshShell, filePath: string): string {
  if (remoteShell === "windows") {
    return encodedPowerShellCommand(`$ProgressPreference='SilentlyContinue'; Remove-Item -LiteralPath ${powershellQuote(filePath)} -Force -ErrorAction SilentlyContinue`);
  }
  return `rm -f -- ${shellQuote(filePath)}`;
}

function remoteScpTarget(remoteShell: RemoteSshShell, sshTarget: string, filePath: string): string {
  // Modern scp uses SFTP by default. The destination is already one argv item,
  // so PowerShell quotes become literal filename characters on Windows.
  const quotedPath = remoteShell === "windows" ? filePath.replace(/\\/g, "/") : shellQuote(filePath);
  return `${sshTarget}:${quotedPath}`;
}

async function testLocalSendSettingsViaSsh(settings: ReturnType<ProjectStore["getLocalSendSettings"]>) {
  const clean = validateLocalSendSettings(settings);
  const sshTarget = `${clean.sshUser}@${clean.sshHost}`;
  const remoteShell = await detectRemoteSshShell(clean, sshTarget);
  const probeName = `.codex-web-ssh-test-${process.pid}-${Date.now()}`;
  const localProbe = path.join(uploadRoot, probeName);
  const remoteProbe = remoteJoin(clean.destinationPath, probeName);
  fs.mkdirSync(uploadRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(localProbe, "codex-web ssh transfer test\n", { mode: 0o600 });
  let transferred = false;
  try {
    await execFileAsync(
      "ssh",
      [...localSshOptions(clean), sshTarget, remoteEnsureDirectoryCommand(remoteShell, clean.destinationPath)],
      { timeout: 30_000, maxBuffer: 512 * 1024 }
    );
    await execFileAsync(
      "scp",
      [...localSshOptions(clean, "-P"), localProbe, remoteScpTarget(remoteShell, sshTarget, remoteProbe)],
      { timeout: 30_000, maxBuffer: 512 * 1024 }
    );
    transferred = true;
  } finally {
    fs.rmSync(localProbe, { force: true });
    if (transferred) {
      await execFileAsync(
        "ssh",
        [...localSshOptions(clean), sshTarget, remoteRemoveFileCommand(remoteShell, remoteProbe)],
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
  const remoteShell = await detectRemoteSshShell(clean, sshTarget);

  await execFileAsync(
    "ssh",
    [...sshOptions, sshTarget, remoteEnsureDirectoryCommand(remoteShell, clean.destinationPath)],
    { timeout: 30_000, maxBuffer: 512 * 1024 }
  );
  const { stdout, stderr } = await execFileAsync(
    "scp",
    [...localSshOptions(clean, "-P"), sourcePath, remoteScpTarget(remoteShell, sshTarget, remoteFile)],
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

function handoffSourceSettings(overrides: Partial<HandoffSourceSettings> = {}) {
  const host = cleanSshScalar(overrides.host ?? serverConfig.handoffSourceHost, "迁移主机");
  const user = cleanSshScalar(overrides.user ?? serverConfig.handoffSourceUser, "SSH 用户");
  const appDir = cleanSshScalar(overrides.appDir ?? serverConfig.handoffSourceAppDir, "应用目录");
  const label = cleanSshScalar(overrides.label ?? serverConfig.handoffSourceLabel, "迁移源");
  if (!host) {
    throw new Error("会话迁移尚未配置源主机连接。");
  }
  if (host.startsWith("-") || /\s/.test(host) || !user || user.startsWith("-") || /[\s@]/.test(user)) {
    throw new Error("迁移 SSH 配置无效。");
  }
  if (!path.isAbsolute(appDir) || /[\0\r\n]/.test(appDir)) {
    throw new Error("迁移应用目录无效。");
  }
  return { host, user, appDir, label };
}

function parseHandoffSourceFromBody(rawBody: unknown): HandoffSourceSettings {
  const parsed = handoffSourceSchema.parse(rawBody ?? {});
  return {
    host: parsed.sourceHost ?? serverConfig.handoffSourceHost,
    user: parsed.sourceUser ?? serverConfig.handoffSourceUser,
    appDir: parsed.sourceAppDir ?? serverConfig.handoffSourceAppDir,
    label: parsed.sourceLabel ?? serverConfig.handoffSourceLabel
  };
}

function safeTarEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
    return false;
  }
  return normalized === "manifest.json" || normalized === "sessions" || normalized.startsWith("sessions/");
}

async function extractHandoffArchive(archivePath: string, destination: string): Promise<void> {
  const listed = await execFileAsync("tar", ["-tzf", archivePath], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
  const entries = String(listed.stdout).split(/\r?\n/).filter(Boolean);
  if (!entries.includes("manifest.json") || entries.some((entry) => !safeTarEntry(entry))) {
    throw new Error("4090-left 返回了不安全的迁移包。");
  }
  await fs.promises.mkdir(destination, { recursive: true, mode: 0o700 });
  await execFileAsync(
    "tar",
    ["--no-same-owner", "--no-same-permissions", "-xzf", archivePath, "-C", destination],
    { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }
  );
}

async function receiveHandoffArchiveFromSource(
  userId: string,
  source: HandoffSourceSettings,
  onProgress?: (bytes: number) => void
): Promise<{ workDir: string; archivePath: string }> {
  const workRoot = path.join(serverConfig.dataDir, "handoffs");
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const workDir = fs.mkdtempSync(path.join(workRoot, "from-handoff-"));
  const archivePath = path.join(workDir, "handoff.tar.gz");
  const output = fs.createWriteStream(archivePath, { flags: "wx", mode: 0o600 });
  const sourceScript = path.join(source.appDir, "scripts", "export-user-sessions.sh");
  const remoteCommand = `CODEX_WEB_INSTANCE_LABEL=${shellQuote(source.label)} ${shellQuote(sourceScript)} ${shellQuote(userId)}`;
  const child = spawn(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", `${source.user}@${source.host}`, remoteCommand],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 16_384) {
      stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length);
    }
  });
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      onProgress?.(bytes);
      if (bytes > serverConfig.handoffMaxBytes) {
        callback(new Error(`迁移包超过限制（${Math.floor(serverConfig.handoffMaxBytes / 1024 / 1024)} MB）。`));
        return;
      }
      callback(null, chunk);
    }
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  try {
    const [exitCode] = await Promise.all([closed, pipeline(child.stdout, limiter, output)]);
    if (exitCode !== 0) {
      throw new Error(`会话导出失败：${stderr.trim() || `ssh exit ${exitCode ?? "unknown"}`}`);
    }
    if (bytes === 0) {
      throw new Error("未返回迁移包。");
    }
    return { workDir, archivePath };
  } catch (error) {
    child.kill("SIGTERM");
    fs.rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

function handoffResultMessage(result: ImportedUserHandoff): string {
  return `已从 ${result.sourceLabel} 迁移 ${result.importedThreadIds.length} 个会话，已存在 ${result.alreadyPresentThreadIds.length} 个；源端可迁移会话 ${result.sourceSessionCount} 个。`;
}

function importHandoffArchive(store: ProjectStore, bridge: CodexBridge, userId: string, extractedDirectory: string) {
  return importStagedUserHandoff(store, userId, extractedDirectory, serverConfig.projectRoot, {
    overwriteExisting: true,
    targetCodexHome: serverConfig.handoffTargetCodexHome || undefined
  }).then((result) => {
    if (serverConfig.handoffTargetAccountId && isAccountPoolBridge(bridge)) {
      bridge.assignThreadsToAccount(
        [...result.importedThreadIds, ...result.alreadyPresentThreadIds],
        serverConfig.handoffTargetAccountId
      );
    }
    return result;
  });
}


function validateServerOutputPath(value: string | undefined, settings: ReturnType<ProjectStore["getLocalSendSettings"]>): string {
  const outputPath = cleanSshScalar(value?.trim() || settings.outputPath || "/tmp/codex_remote_exports", "4090-left 临时中转目录");
  if (!outputPath) {
    throw new Error("请先在设置里填写 4090-left 临时中转目录。");
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
  if (error instanceof LegacyRollbackConflictError) return 409;
  if (error instanceof PathPolicyError || error instanceof z.ZodError || error instanceof ThreadContextConfigError) {
    if (error instanceof PathPolicyError && error.message === "File does not exist.") {
      return 404;
    }
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

export function branchTitle(sourceName: string, targetAccountLabel: string | null, sourceAccountLabel: string | null): string {
  const shortLabel = (label: string) => /^\d{6}$/.test(label) ? label.slice(-4) : label;
  let base = sourceName.trim() || "会话";
  const previousLabel = sourceAccountLabel?.trim();
  const previousSuffixes = previousLabel
    ? [` - ${shortLabel(previousLabel)}`, ` - ${previousLabel}`, " · 分支"]
    : [" · 分支"];
  for (const suffix of previousSuffixes) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length).trimEnd() || "会话";
      break;
    }
  }
  const label = targetAccountLabel?.trim();
  if (!label) return Array.from(base).slice(0, 160).join("");
  const suffix = ` - ${shortLabel(label)}`;
  return `${Array.from(base).slice(0, Math.max(0, 160 - Array.from(suffix).length)).join("")}${suffix}`;
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

function resolvedThreadModelPresentation(
  store: ProjectStore,
  userId: string,
  threadId: string,
  presentation: ThreadPresentation | undefined
): { model: string; reasoningEffort: ReasoningEffort } {
  const owner = store.getThreadOwner(threadId);
  const ownerProject = owner?.userId === userId ? store.getProject(owner.projectId, userId) : null;
  return {
    model: presentation?.model ?? ownerProject?.defaultModel ?? defaults.model,
    reasoningEffort: presentation?.reasoningEffort ?? ownerProject?.defaultReasoningEffort ?? defaults.reasoningEffort
  };
}

export function applyThreadPresentation(
  thread: unknown,
  presentation: ThreadPresentation | undefined,
  modelPresentation: { model: string; reasoningEffort: ReasoningEffort }
): Record<string, unknown> {
  return {
    ...asRecord(thread),
    pinned: presentation?.pinned === true,
    configuredModel: modelPresentation.model,
    configuredReasoningEffort: modelPresentation.reasoningEffort
  };
}

function sortThreadsForUser(store: ProjectStore, userId: string, items: unknown[]): unknown[] {
  const preferences = store.getThreadPresentation(userId, items.map(threadIdFromListItem).filter((threadId): threadId is string => Boolean(threadId)));
  return items
    .map((item, index) => {
      const threadId = threadIdFromListItem(item);
      const presentation = threadId ? preferences.get(threadId) : undefined;
      const modelPresentation = threadId ? resolvedThreadModelPresentation(store, userId, threadId, presentation) : null;
      const record = asRecord(item);
      return {
        item: threadId
          ? {
              ...record,
        name: presentation?.displayName ?? record.name,
              pinned: presentation?.pinned === true,
              configuredModel: modelPresentation?.model ?? null,
              configuredReasoningEffort: modelPresentation?.reasoningEffort ?? null
            }
          : item,
        pinned: presentation?.pinned === true,
        manualOrder: presentation?.manualOrder ?? null,
        originalIndex: index
      };
    })
    .sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }
      if (left.manualOrder !== null && right.manualOrder !== null && left.manualOrder !== right.manualOrder) {
        return left.manualOrder - right.manualOrder;
      }
      if (left.manualOrder !== null) {
        return -1;
      }
      if (right.manualOrder !== null) {
        return 1;
      }
      const byUpdatedAt = listItemUpdatedAt(right.item) - listItemUpdatedAt(left.item);
      return byUpdatedAt || left.originalIndex - right.originalIndex;
    })
    .map((entry) => entry.item);
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

function threadUserItemText(item: Record<string, unknown>): string {
  for (const value of [item.text, item.message, item.input, item.prompt]) {
    if (typeof value === "string") return value;
  }
  if (Array.isArray(item.content)) {
    return item.content.map((part) => {
      if (typeof part === "string") return part;
      const record = asRecord(part);
      return typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

export function sanitizeThreadPayloadForClient<T>(value: T): T {
  const root = asRecord(value);
  const thread = asRecord(root.thread ?? value);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turnValue of turns) {
    const turn = asRecord(turnValue);
    const items = Array.isArray(turn.items) ? turn.items : [];
    const containsContextCompaction = items.some(isContextCompactionItem);
    const clientItems = items.filter((itemValue) => {
      const item = asRecord(itemValue);
      const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
      const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
      if (isContextCompactionItem(item)) {
        return false;
      }
      if (
        containsContextCompaction
        && (role === "assistant" || itemType.includes("agent"))
        && isGenericContextLossReply(threadUserItemText(item))
      ) {
        return false;
      }
      if (role !== "user" && !itemType.includes("user")) return true;
      const text = threadUserItemText(item).trim();
      return !isInternalUserMessageText(text);
    });
    turn.items = clientItems;
    for (const itemValue of clientItems) {
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


async function readOwnedThreadSummariesFromJsonl(ownedThreadIds: Set<string>): Promise<unknown[] | null> {
  const threadIds = [...ownedThreadIds];
  if (!threadIds.length) return [];
  const targets = await Promise.all(threadIds.map(async (threadId) => ({
    threadId,
    filePath: await findThreadJsonlPathById(threadId)
  })));
  // A mixed account project may still contain a legacy thread outside the
  // primary CODEX_HOME. Fall back to app-server's merged list in that case so
  // correctness is preserved while the common current-workspace path stays fast.
  if (targets.some((target) => !target.filePath)) return null;

  const summaries: unknown[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const target = targets[next++];
      if (!target) return;
      try {
        summaries.push(await readThreadSummaryFromJsonl(target.filePath as string, target.threadId));
      } catch {
        // A damaged file needs the normal app-server recovery path.
        summaries.length = 0;
        next = targets.length;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, targets.length) }, () => worker()));
  return summaries.length === targets.length ? summaries : null;
}

const pendingIndexWarm = new Set<string>();
const lastIndexWarm = new Map<string, number>();
let backgroundIndexWarmPromise: Promise<void> | null = null;
function warmOwnedThreadIndexes(ownedThreadIds: Set<string>): void {
  for (const id of ownedThreadIds) {
    if (Date.now() - (lastIndexWarm.get(id) ?? 0) > 10_000) pendingIndexWarm.add(id);
  }
  if (backgroundIndexWarmPromise) return;
  backgroundIndexWarmPromise = (async () => {
    while (pendingIndexWarm.size) {
      const threadId = pendingIndexWarm.values().next().value!;
      pendingIndexWarm.delete(threadId);
      try {
        const filePath = await findThreadJsonlPathById(threadId);
        if (filePath) await warmThreadIndex(filePath, threadId);
      } catch {
        // One missing historical file must not starve other users' indexes.
      }
      lastIndexWarm.set(threadId, Date.now());
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  })().finally(() => { backgroundIndexWarmPromise = null; });
}

async function filterOwnedThreadList(
  bridge: CodexBridge,
  items: unknown[],
  ownedThreadIds: Set<string>,
  searchTerm: string,
  hydrateMissing = true
): Promise<unknown[]> {
  const byId = new Map<string, unknown>();
  for (const item of items) {
    const threadId = threadIdFromListItem(item);
    if (threadId && ownedThreadIds.has(threadId)) {
      byId.set(threadId, item);
    }
  }

  for (const threadId of hydrateMissing ? ownedThreadIds : []) {
    if (byId.has(threadId)) {
      continue;
    }
    const fullThread = await readOwnedThreadForList(bridge, threadId);
    // Ownership is the access boundary. A legacy session may retain /home/<user> as
    // its historical cwd after the user's default workspace is moved.
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

function ensureProjectsForUser(store: ProjectStore, userId: string) {
  const rootPath = userWorkspacePath(userId);
  fs.mkdirSync(rootPath, { recursive: true, mode: 0o700 });

  // List the personal workspace first: a newly opened page selects it by
  // default. Existing projects (including historical /home/<user> conversations)
  // are deliberately retained below it.
  const workspace = store.getProjectByRootPath(rootPath, userId) ?? store.createProject({
    name: "我的工作区",
    rootPath,
    userId
  });
  const otherProjects = store.listProjects(userId).filter((project) => project.id !== workspace.id);
  return [workspace, ...otherProjects];
}

const deferredToolOutputPreviewBytes = 4 * 1024;

export function inlineContentDisposition(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback || "file"}"; filename*=UTF-8''${encoded}`;
}

function deferLargeToolOutputs(threadValue: unknown): void {
  const thread = asRecord(threadValue);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turnValue of turns) {
    const turn = asRecord(turnValue);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const itemValue of items) {
      const item = asRecord(itemValue);
      let deferredBytes = 0;
      for (const field of ["aggregatedOutput", "output"] as const) {
        const output = item[field];
        if (typeof output !== "string") continue;
        const outputBytes = Buffer.byteLength(output);
        if (outputBytes <= deferredToolOutputPreviewBytes) continue;
        const preview = output.slice(0, deferredToolOutputPreviewBytes);
        item[field] = `${preview}\n\n[完整工具输出 ${outputBytes.toLocaleString("en-US")} bytes，展开后按需加载]`;
        deferredBytes = Math.max(deferredBytes, outputBytes);
      }
      if (deferredBytes > 0) {
        item.outputDeferred = true;
        item.outputBytes = deferredBytes;
      }
    }
  }
}

export function registerRoutes(app: FastifyInstance, bridge: CodexBridge, store: ProjectStore, options: { backgroundIndexing?: boolean } = {}): void {
  const pushSubscriptionSchema = z.object({
    endpoint: z.string().url().max(2048),
    keys: z.object({ p256dh: z.string().min(32).max(256), auth: z.string().min(8).max(128) }).strict()
  }).strict();
  const trustedPushHosts = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
  const validatePushEndpoint = (endpoint: string) => {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || !trustedPushHosts.has(url.hostname) || url.username || url.password || url.port) {
      throw new Error("Unsupported browser push endpoint.");
    }
  };
  app.get("/api/push/key", async (request) => {
    userIdFromRequest(request, store);
    return { data: { publicKey: pushPublicKey() } };
  });
  app.post("/api/push/subscription", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const subscription = pushSubscriptionSchema.parse(request.body);
      validatePushEndpoint(subscription.endpoint);
      store.savePushSubscription(userId, subscription);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.delete("/api/push/subscription", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const { endpoint } = z.object({ endpoint: z.string().url() }).parse(request.body);
      store.removePushSubscription(userId, endpoint);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  let searchRefreshTimer: ReturnType<typeof setInterval> | undefined;
  app.addHook("onReady", async () => {
    if (options.backgroundIndexing === false) return;
    startChatSearch();
    const refresh = () => {
      const ids = new Set(store.listUsers().flatMap(user => store.listVisibleThreadOwnersForUser(user.id).map(owner => owner.threadId)));
      warmOwnedThreadIndexes(ids);
    };
    refresh();
    searchRefreshTimer = setInterval(refresh, 15_000);
    searchRefreshTimer.unref();
  });
  app.addHook("onClose", async () => { if (searchRefreshTimer) clearInterval(searchRefreshTimer); });

  app.get<{ Querystring: { q?: string; offset?: string; limit?: string; projectId?: string } }>("/api/search/threads", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const query = normalizeSearchTerm(request.query.q);
    if (!query || query.length > 512) return reply.code(400).send({ error: "Search requires 1–512 characters." });
    const projectId = request.query.projectId;
    if (projectId && !store.getProject(projectId, userId)) return reply.code(404).send({ error: "Project not found." });
    const owners = store.listVisibleThreadOwnersForUser(userId).filter(owner => !projectId || owner.projectId === projectId);
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once("close", disconnected);
    try {
      return await searchChatThreads(owners, query, {
        offset: Math.max(0, Number.parseInt(request.query.offset ?? "0", 10) || 0),
        limit: Math.min(80, Math.max(1, Number.parseInt(request.query.limit ?? "30", 10) || 30))
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) });
    } finally { reply.raw.off("close", disconnected); }
  });
  app.get<{ Params: { threadId: string }; Querystring: { q?: string; projectId?: string } }>("/api/search/threads/:threadId/hits", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const query = normalizeSearchTerm(request.query.q);
    if (!query || query.length > 512) return reply.code(400).send({ error: "Search requires 1–512 characters." });
    const owner = store.listVisibleThreadOwnersForUser(userId).find(entry => entry.threadId === request.params.threadId
      && (!request.query.projectId || entry.projectId === request.query.projectId));
    if (!owner) return reply.code(404).send({ error: "Thread not found." });
    try { return await searchChatThreadHits(owner.threadId, query); }
    catch (error) { return reply.code(503).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  const publicHandoffJob = (job: HandoffJob) => ({
    id: job.id,
    status: job.status,
    phase: job.phase,
    bytesTransferred: job.bytesTransferred,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    result: job.result,
    message: job.message,
    error: job.error
  });

  const runHandoffJob = async (job: HandoffJob) => {
    let workDir: string | null = null;
    try {
      const source = handoffSourceSettings();
      job.phase = "connecting";
      job.updatedAt = new Date().toISOString();
      const received = await receiveHandoffArchiveFromSource(job.userId, source, (bytes) => {
        job.phase = "transferring";
        job.bytesTransferred = bytes;
        job.updatedAt = new Date().toISOString();
      });
      workDir = received.workDir;
      job.phase = "extracting";
      job.updatedAt = new Date().toISOString();
      const extractedDirectory = path.join(workDir, "extracted");
      await extractHandoffArchive(received.archivePath, extractedDirectory);
      job.phase = "importing";
      job.updatedAt = new Date().toISOString();
      const result = await importHandoffArchive(store, bridge, job.userId, extractedDirectory);
      if (result.sourceSessionCount === 0) {
        throw new Error(`${source.label} 上没有用户「${job.userId}」的可迁移会话。`);
      }
      job.result = result;
      job.status = "completed";
      job.phase = "completed";
      job.message = handoffResultMessage(result);
    } catch (error) {
      job.status = "failed";
      job.phase = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.updatedAt = new Date().toISOString();
      if (workDir) await fs.promises.rm(workDir, { recursive: true, force: true });
      handoffInFlightUsers.delete(job.userId);
      if (handoffJobIdsByUser.get(job.userId) === job.id) handoffJobIdsByUser.delete(job.userId);
    }
  };

  app.get("/api/health", async (request) => ({
    ok: true,
    branchImplementation: "load-balanced-native-v3",
    codexPendingApprovals: bridge.getPendingServerRequests().length,
    projectRoot: serverConfig.projectRoot,
    allowOutsideProjectRoot: serverConfig.allowOutsideProjectRoot,
    systemDirectoryPickerAvailable: systemDirectoryPickerAvailableForRequest(request),
    threadContextFeatureEnabled,
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

  app.get<{ Querystring: { refresh?: string; threadId?: string } }>("/api/codex/account-pool", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      if (!isAccountPoolBridge(bridge)) {
        const quota = await readCachedCodexQuota(bridge, request.query.refresh === "true");
        return {
          data: {
            strategy: "single-account",
            accounts: [{
              id: serverConfig.leaderboardAccountLabel,
              label: serverConfig.leaderboardAccountLabel,
              health: "ready",
              selectedForNewThreads: true,
              assignedThreadCount: 0,
              activeRequests: 0,
              lastError: null,
              lastCheckedAt: quota.updatedAt,
              quota
            }],
            updatedAt: new Date().toISOString()
          }
        };
      }
      const snapshots = await bridge.refreshAccountData(request.query.refresh === "true");
      const currentThreadAccount = bridge.getKnownThreadAccount(request.query.threadId?.trim());
      return {
        data: {
          strategy: "highest-remaining-sticky-thread",
          currentThreadAccountId: currentThreadAccount?.id ?? null,
          currentThreadAccountLabel: currentThreadAccount?.label ?? null,
          accounts: snapshots.map((entry) => ({
            id: entry.id,
            label: entry.label,
            kind: entry.kind,
            health: entry.health,
            selectedForNewThreads: entry.selectedForNewThreads,
            assignedThreadCount: entry.assignedThreadCount,
            activeRequests: entry.activeRequests,
            lastError: entry.lastError,
            lastCheckedAt: entry.lastCheckedAt,
            quota: sanitizeCodexQuota(entry.account, entry.limits, entry.usage, entry.errors)
          })),
          updatedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Querystring: { refresh?: string; local?: string } }>("/api/codex/leaderboard", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      const forceRefresh = request.query.refresh === "true";
      if (!forceRefresh && leaderboardCache && leaderboardCache.expiresAt > Date.now()) {
        return { data: leaderboardCache.data };
      }
      // A token refresh must not wait for every provider's auth/quota probes.
      // The quota bridge refreshes its own cached snapshot independently.
      const sources = await leaderboardAccountSources(bridge, false);
      // Never merge peer boards into the normal endpoint. A peer can expose
      // historical JSONL records for the same login, which is useful for an
      // audit but misleading as a current-service quota view.
      return { data: await readCachedCodexLeaderboard(sources, store, forceRefresh, false) };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Querystring: { refresh?: string } }>("/api/codex/tracked-quota", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      return { data: await readTrackedQuotaUsage(bridge, store, request.query.refresh === "true") };
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

  app.get<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/mcp-status", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project || !store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(404).send({ error: "Thread not found." });
      }
      const result = await bridge.request("mcpServerStatus/list", {
        threadId: request.params.threadId,
        detail: "toolsAndAuthOnly",
        limit: 100
      }, 30_000);
      return sanitizeMcpServerStatus(result);
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { threadId?: string } }>("/api/projects/:id/hooks", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const project = store.getProject(request.params.id, userId);
    if (!project) return reply.code(404).send({ error: "Project not found." });
    if (request.query.threadId && !store.userCanAccessThread(request.query.threadId, userId, project.id)) {
      return reply.code(404).send({ error: "Thread not found." });
    }
    try {
      const entry = await listHooksForProject(bridge, project, request.query.threadId);
      const grants = store.getProjectHookTrust(userId, project.id);
      return { data: {
        hooks: entry.hooks.map(hook => ({
          key: String(hook.key ?? ""), eventName: String(hook.eventName ?? ""),
          handlerType: String(hook.handlerType ?? ""), source: String(hook.source ?? ""),
          pluginId: typeof hook.pluginId === "string" ? hook.pluginId : null,
          enabled: hook.enabled === true, isManaged: hook.isManaged === true,
          trustStatus: String(hook.trustStatus ?? "unknown"),
          matcher: typeof hook.matcher === "string" ? hook.matcher : null,
          trustable: !hook.isManaged && isProjectLocalHook(project.rootPath, hook.sourcePath),
          currentHash: isProjectLocalHook(project.rootPath, hook.sourcePath) && typeof hook.currentHash === "string" ? hook.currentHash : null,
          command: isProjectLocalHook(project.rootPath, hook.sourcePath) && typeof hook.command === "string" ? hook.command : null,
          userTrusted: Boolean(hook.key && hook.currentHash && isProjectLocalHook(project.rootPath, hook.sourcePath) && grants.get(hook.key) === hook.currentHash)
        })),
        warnings: entry.warnings.map(String),
        errors: entry.errors.map(error => String(error.message ?? ""))
      } };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/hooks", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const project = store.getProject(request.params.id, userId);
    if (!project) return reply.code(404).send({ error: "Project not found." });
    try {
      const userRoot = fs.realpathSync(path.join(userWorkspaceRoot, userId));
      const managedRoot = path.join(userWorkspaceRoot, ".codex-web-worktrees");
      const root = fs.realpathSync(project.rootPath);
      if (root !== userRoot && !root.startsWith(`${userRoot}${path.sep}`) && !root.startsWith(`${managedRoot}${path.sep}`)) {
        return reply.code(403).send({ error: "只能在自己的工作区中新增项目 Hook。" });
      }
      const input = z.object({
        eventName: z.enum(["SessionStart", "Stop", "PreToolUse", "PostToolUse"]),
        matcher: z.string().trim().max(120).optional(),
        command: z.string().trim().min(1).max(1000)
      }).parse(request.body);
      const hookDir = path.join(root, ".codex");
      const hookFile = path.join(hookDir, "hooks.json");
      if (fs.existsSync(hookDir) && (fs.lstatSync(hookDir).isSymbolicLink() || !fs.lstatSync(hookDir).isDirectory())) {
        return reply.code(400).send({ error: ".codex 不是普通目录。" });
      }
      if (fs.existsSync(hookFile) && (fs.lstatSync(hookFile).isSymbolicLink() || !fs.lstatSync(hookFile).isFile())) {
        return reply.code(400).send({ error: "hooks.json 不是普通文件。" });
      }
      const config = fs.existsSync(hookFile) ? JSON.parse(fs.readFileSync(hookFile, "utf8")) as Record<string, unknown> : {};
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("现有 hooks.json 格式不是对象，未修改文件。");
      const hooks = config.hooks === undefined ? {} : config.hooks;
      if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("现有 hooks.json 的 hooks 字段无效，未修改文件。");
      const groups = (hooks as Record<string, unknown>)[input.eventName] ?? [];
      if (!Array.isArray(groups)) throw new Error("现有 Hook 事件格式无效，未修改文件。");
      const command = input.command;
      const matcher = input.matcher || (input.eventName === "PreToolUse" || input.eventName === "PostToolUse" ? "Bash" : undefined);
      const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 30 }] };
      fs.mkdirSync(hookDir, { recursive: true, mode: 0o700 });
      const next = { ...config, hooks: { ...hooks, [input.eventName]: [...groups, group] } };
      const temporary = path.join(hookDir, `hooks.json.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, hookFile);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return reply.code(201).send({ ok: true, path: hookFile });
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string }; Querystring: { threadId?: string } }>("/api/projects/:id/hooks/trust", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const project = store.getProject(request.params.id, userId);
    if (!project) return reply.code(404).send({ error: "Project not found." });
    if (request.query.threadId && !store.userCanAccessThread(request.query.threadId, userId, project.id)) {
      return reply.code(404).send({ error: "Thread not found." });
    }
    try {
      const input = z.object({ key: z.string().min(1).max(1000), currentHash: z.string().min(1).max(256), trusted: z.boolean() }).parse(request.body);
      const listed = await listHooksForProject(bridge, project, request.query.threadId);
      const hook = listed.hooks.find(item => item.key === input.key && item.currentHash === input.currentHash);
      if (!hook || hook.isManaged || !isProjectLocalHook(project.rootPath, hook.sourcePath)) {
        return reply.code(400).send({ error: "该 Hook 已变化或不属于当前工作区，不能授予信任。" });
      }
      store.setProjectHookTrust(userId, project.id, input.key, input.trusted ? input.currentHash : null);
      return { ok: true };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
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
      data: settingsForCurrentAccessDevice(store.getLocalSendSettings(userId), request, userId),
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
      const data = await testLocalSendSettingsViaSsh(settingsForCurrentAccessDevice(store.getLocalSendSettings(userId), request, userId));
      return { data };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/handoff/from-4090-left", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const existingJobId = handoffJobIdsByUser.get(userId);
    const existingJob = existingJobId ? handoffJobs.get(existingJobId) : undefined;
    if (existingJob?.status === "running") return reply.code(202).send({ data: publicHandoffJob(existingJob) });
    const now = new Date().toISOString();
    const job: HandoffJob = {
      id: `handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
      userId,
      status: "running",
      phase: "connecting",
      bytesTransferred: 0,
      startedAt: now,
      updatedAt: now
    };
    handoffJobs.set(job.id, job);
    handoffJobIdsByUser.set(userId, job.id);
    handoffInFlightUsers.add(userId);
    void runHandoffJob(job);
    return reply.code(202).send({ data: publicHandoffJob(job) });
  });

  app.get<{ Params: { jobId: string } }>("/api/handoff/from-4090-left/status/:jobId", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const job = handoffJobs.get(request.params.jobId);
    if (!job || job.userId !== userId) {
      return reply.code(404).send({ error: "迁移任务不存在或已过期。" });
    }
    return { data: publicHandoffJob(job) };
  });

  app.post("/api/handoff/from-source", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    if (handoffInFlightUsers.has(userId)) {
      return reply.code(409).send({ error: "该用户的会话迁移正在进行，请等待完成。" });
    }
    handoffInFlightUsers.add(userId);
    let workDir: string | null = null;
    try {
      const source = parseHandoffSourceFromBody(request.body);
      const received = await receiveHandoffArchiveFromSource(userId, handoffSourceSettings(source));
      workDir = received.workDir;
      const extractedDirectory = path.join(workDir, "extracted");
      await extractHandoffArchive(received.archivePath, extractedDirectory);
      const data = await importHandoffArchive(store, bridge, userId, extractedDirectory);
      if (data.sourceSessionCount === 0) {
        return reply.code(404).send({
          error: `${source.label} 上没有用户「${userId}」的可迁移会话，无法迁移。`,
          data
        });
      }
      return { data, message: handoffResultMessage(data) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const conflict = /目标端.*(其他用户|内容不同|不是普通文件)|正在进行/.test(message);
      const unavailable = /尚未配置|ssh exit|会话导出失败|未返回迁移包/.test(message);
      return reply.code(conflict ? 409 : unavailable ? 502 : 500).send({ error: message });
    } finally {
      handoffInFlightUsers.delete(userId);
      if (workDir) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }
  });

  app.get("/api/projects", async (request) => {
    const userId = userIdFromRequest(request, store);
    return {
      data: ensureProjectsForUser(store, userId),
      projectRoot: serverConfig.projectRoot,
      allowOutsideProjectRoot: serverConfig.allowOutsideProjectRoot,
      systemDirectoryPickerAvailable: systemDirectoryPickerAvailableForRequest(request),
      threadContextFeatureEnabled
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

  app.get<{ Params: { id: string } }>("/api/projects/:id/git-repositories", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const source = store.getProject(request.params.id, userId);
    if (!source) return reply.code(404).send({ error: "Project not found." });
    try {
      const roots = await discoverGitRepositories(source.rootPath);
      return { data: roots.map(rootPath => ({ rootPath, name: path.basename(rootPath) })) };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/worktrees", async (request, reply) => {
    const userId = userIdFromRequest(request, store);
    const source = store.getProject(request.params.id, userId);
    if (!source) return reply.code(404).send({ error: "Project not found." });
    try {
      const input = createWorktreeSchema.parse(request.body ?? {});
      const repositoryRoot = assertRepositoryWithinProject(source.rootPath, input.repositoryPath ?? source.rootPath);
      const token = randomUUID();
      // Keep the child outside the source repository so Git never sees it as
      // an untracked nested checkout. Project ids are server-generated UUIDs.
      const parent = path.join(userWorkspaceRoot, ".codex-web-worktrees", source.id);
      const { rootPath: worktreePath, branch } = await createManagedWorktree(repositoryRoot, parent, token);
      try {
        const project = store.createProject({
          name: input.name || `${path.basename(repositoryRoot)} · 独立工作树`, rootPath: worktreePath, userId,
          defaultModel: source.defaultModel, defaultReasoningEffort: source.defaultReasoningEffort,
          defaultSandbox: source.defaultSandbox, defaultApprovalPolicy: source.defaultApprovalPolicy
        });
        return reply.code(201).send({ data: project, branch, sourceProjectId: source.id, repositoryRoot });
      } catch (error) {
        await removeManagedWorktree(repositoryRoot, worktreePath);
        throw error;
      }
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
        allowOutsideRoot: serverConfig.allowOutsideProjectRoot,
        allowLegacyUploadRoots: [uploadRoot]
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
        allowOutsideRoot: serverConfig.allowOutsideProjectRoot,
        allowLegacyUploadRoots: [uploadRoot]
      });
      const stat = fs.statSync(target.filePath);
      if (!stat.isFile()) {
        return reply.code(400).send({ error: "Path is not a file." });
      }
      const filename = path.basename(target.filePath);
      return reply
        .type(mimeTypeForPath(target.filePath))
        .header("Content-Length", String(stat.size))
        .header("Content-Disposition", inlineContentDisposition(filename))
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
      const result = await sendFileToLocalViaSsh(settingsForCurrentAccessDevice(store.getLocalSendSettings(userId), request, userId), target.filePath, input.destinationPath);
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

  app.get<{ Params: { id: string }; Querystring: { archived?: string; search?: string; fast?: string } }>(
    "/api/projects/:id/threads",
    async (request, reply) => {
      const project = store.getProject(request.params.id, userIdFromRequest(request, store));
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }

      try {
        const userId = userIdFromRequest(request, store);
        // Every workspace is a strict ownership boundary.  In particular,
        // sessions imported into `codex1 迁移会话` must never leak into the
        // personal `我的工作区` list for the same user.
        const ownedThreadIds = store.ownedThreadIds(userId, project.id);
        const locallyArchivedIds = store.locallyArchivedThreadIds(userId, project.id);
        const searchTerm = normalizeSearchTerm(request.query.search);
        if (searchTerm) {
          const owners = store.listVisibleThreadOwnersForUser(userId).filter(owner => owner.projectId === project.id && !locallyArchivedIds.has(owner.threadId));
          const result = await searchChatThreads(owners, searchTerm, { limit: 80 });
          return {
            ...result,
            data: sortThreadsForUser(store, userId, result.data),
            nextCursor: null,
            backwardsCursor: null
          };
        }
        const archived = request.query.archived === "true";
        const fast = request.query.fast !== "false" && !archived;
        warmOwnedThreadIndexes(ownedThreadIds);
        if (fast) {
          const summaries = await readOwnedThreadSummariesFromJsonl(new Set([...ownedThreadIds].filter(id => !locallyArchivedIds.has(id))));
          if (summaries) {
            return {
              data: sortThreadsForUser(store, userId, summaries),
              nextCursor: null,
              backwardsCursor: null
            };
          }
        }
        const listParams = {
          // Query global summaries, then strictly filter by per-user ownership.
          // This includes historical sessions whose cwd predates the workspace move.
          limit: THREAD_LIST_PAGE_SIZE,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived,
          // Empty string forces app-server to scan and repair JSONL metadata; null can miss recent cwd-matched threads.
          // We do fuzzy matching after ownership filtering so app-server search cannot hide owned threads unexpectedly.
          searchTerm: fast ? null : "",
          useStateDbOnly: fast
        };
        let result;
        try {
          result = await listAllCodexThreads(bridge, listParams);
        } catch (error) {
          // A just-archived thread is already recorded locally. Keep its
          // restore entry available while app-server's account list recovers.
          if (!archived || !locallyArchivedIds.size) throw error;
          result = { data: [], nextCursor: null, backwardsCursor: null };
        }
        const nativeData = await filterOwnedThreadList(bridge, result.data, ownedThreadIds, "", !archived);
        if (archived) {
          for (const item of nativeData) {
            const threadId = threadIdFromListItem(item);
            if (threadId) {
              store.setThreadLocallyArchived(threadId, userId, project.id, true);
              locallyArchivedIds.add(threadId);
            }
          }
        }
        let data = nativeData.filter(item => archived || !locallyArchivedIds.has(threadIdFromListItem(item) ?? ""));
        if (archived && locallyArchivedIds.size) {
          const localData = await readOwnedThreadSummariesFromJsonl(locallyArchivedIds)
            ?? await filterOwnedThreadList(bridge, [], locallyArchivedIds, "", true);
          const seen = new Set(data.map(item => threadIdFromListItem(item)));
          data = [...data, ...localData.filter(item => !seen.has(threadIdFromListItem(item)))];
        }
        return {
          ...result,
          data: sortThreadsForUser(store, userId, data),
          nextCursor: null,
          backwardsCursor: null
        };
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  app.post<{ Params: { id: string; threadId: string; action: string } }>("/api/projects/:id/threads/:threadId/:action", async (request, reply) => {
    const { id, threadId, action } = request.params;
    if (action !== "archive" && action !== "unarchive") return reply.code(404).send({ error: "Unknown action." });
    const userId = userIdFromRequest(request, store);
    const project = store.getProject(id, userId);
    if (!project || !store.userCanAccessThread(threadId, userId, id)) return reply.code(404).send({ error: "Thread not found." });
    const locallyTracked = store.locallyArchivedThreadIds(userId, id).has(threadId);
    try {
      await bridge.request(action === "archive" ? "thread/archive" : "thread/unarchive", { threadId }, 30_000);
      store.setThreadLocallyArchived(threadId, userId, id, action === "archive");
      return { ok: true };
    } catch (error) {
      if (error instanceof Error
          && error.message.includes("Codex thread was not found in any configured account.")
          && (locallyTracked || await findThreadJsonlPathById(threadId))) {
        store.setThreadLocallyArchived(threadId, userId, id, action === "archive");
        return { ok: true, locallyArchived: true };
      }
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/presentation", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const projectId = project.id;
      if (!store.userCanAccessThread(request.params.threadId, userId, projectId)) {
        return reply.code(404).send({ error: "Thread not found." });
      }
      const input = threadPresentationSchema.parse(request.body);
      const data = store.setThreadPinned(request.params.threadId, userId, input.pinned);
      if (!data) {
        return reply.code(404).send({ error: "Thread not found." });
      }
      return { data };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/context", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project || !store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(404).send({ error: "Thread not found." });
      }
      const config = store.getThreadContextConfig(request.params.threadId, userId)
        ?? defaultThreadContextConfig(request.params.threadId);
      const [usage, pin] = await Promise.all([
        readThreadContextUsage(request.params.threadId, config),
        Promise.resolve(store.getThreadContextPin(request.params.threadId, userId))
      ]);
      return {
        data: {
          ...usage,
          config,
          pin: pin ?? { threadId: request.params.threadId, text: "", updatedAt: null }
        }
      };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string; threadId: string }; Querystring: { view?: string; q?: string; cursor?: string; limit?: string } }>("/api/projects/:id/threads/:threadId/subagents", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) return reply.code(404).send({ error: "Project not found." });
      if (!store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }
      const query = request.query ?? {};
      const view = query.view ?? "all";
      if (!(["all", "active", "history"].includes(view)) || (query.q !== undefined && query.q.length > 256)
        || (query.limit !== undefined && !/^\d+$/.test(query.limit)) || (query.cursor !== undefined && query.cursor.length > 1024)) {
        return reply.code(400).send({ error: "Invalid subagent directory query." });
      }
      const limit = query.limit === undefined ? 40 : Number(query.limit);
      if (limit < 1 || limit > 100) return reply.code(400).send({ error: "limit must be between 1 and 100." });
      try {
        return await readSubagentDirectoryPage(request.params.threadId, configuredSubagentRuntimeHomes(request.params.threadId), {
          view: view as "all" | "active" | "history", q: query.q, cursor: query.cursor, limit,
          resolveSessionFile: (id, sessionsRoot) => findThreadJsonlPathById(id, sessionsRoot)
        });
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string; threadId: string; agentThreadId: string }; Querystring: { before?: string; cursor?: string; fresh?: string; limit?: string } }>("/api/projects/:id/threads/:threadId/subagents/:agentThreadId", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) return reply.code(404).send({ error: "Project not found." });
      if (!store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }
      const input = threadReadQuerySchema.parse(request.query ?? {});
      const record = findSubagentDescendant(request.params.threadId, request.params.agentThreadId, configuredSubagentRuntimeHomes(request.params.threadId));
      if (!record) return reply.code(404).send({ error: "Subagent thread not found." });
      const sessionsRoot = path.join(record.runtimeHome, "sessions");
      const filePath = await findThreadJsonlPathById(record.id, sessionsRoot);
      if (!filePath) return reply.code(404).send({ error: "Subagent history file not found." });
      const indexedPage = await readIndexedThreadPage(filePath, record.id, {
        before: input.before,
        cursor: input.cursor,
        limit: input.limit,
        backgroundRefresh: !input.fresh && input.before === 0 && !input.cursor
      });
      const result = sanitizeThreadPayloadForClient({ thread: indexedPage.thread });
      deferLargeToolOutputs(asRecord(result).thread);
      return { thread: asRecord(result).thread, history: indexedPage.history };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string; threadId: string; agentThreadId: string; itemId: string } }>("/api/projects/:id/threads/:threadId/subagents/:agentThreadId/items/:itemId/output", async (request, reply) => {
    try {
      reply.header("Cache-Control", "private, max-age=300");
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) return reply.code(404).send({ error: "Project not found." });
      if (!store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }
      const record = findSubagentDescendant(request.params.threadId, request.params.agentThreadId, configuredSubagentRuntimeHomes(request.params.threadId));
      if (!record) return reply.code(404).send({ error: "Subagent thread not found." });
      const sessionsRoot = path.join(record.runtimeHome, "sessions");
      const filePath = await findThreadJsonlPathById(record.id, sessionsRoot);
      const indexedItem = filePath ? await readIndexedThreadItem(filePath, record.id, request.params.itemId) : null;
      if (!indexedItem) return reply.code(404).send({ error: "Tool output was not found in the thread index." });
      const output = typeof indexedItem.aggregatedOutput === "string"
        ? indexedItem.aggregatedOutput
        : typeof indexedItem.output === "string" ? indexedItem.output : "";
      return { data: { output, bytes: Buffer.byteLength(output) } };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/context-config", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project || !store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(404).send({ error: "Thread not found." });
      }
      const input = threadContextConfigSchema.parse(request.body ?? {});
      const resolved = threadContextFeatureEnabled
        ? resolveThreadContextConfig(request.params.threadId, input)
        : defaultThreadContextConfig(request.params.threadId);
      const data = store.setThreadContextConfig(request.params.threadId, userId, {
        profile: resolved.profile,
        contextWindow: resolved.contextWindow,
        compactTokenLimit: resolved.compactTokenLimit,
        scope: resolved.scope
      });
      if (!data) return reply.code(404).send({ error: "Thread not found." });
      return { data };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/context-pin", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project || !store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(404).send({ error: "Thread not found." });
      }
      const input = threadContextPinSchema.parse(request.body ?? {});
      const data = store.setThreadContextPin(request.params.threadId, userId, input.text);
      if (!data) return reply.code(404).send({ error: "Thread not found." });
      return { data };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/model-profile", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const projectId = project.id;
      if (!store.userCanAccessThread(request.params.threadId, userId, projectId)) {
        return reply.code(404).send({ error: "Thread not found." });
      }
      const input = threadModelProfileSchema.parse(request.body);
      const supported = listModelProfiles().some((profile) => profile.model === input.model && profile.effort === input.reasoningEffort);
      if (!supported) {
        return reply.code(400).send({ error: "Selected model profile is not available." });
      }
      const poolBridge = isAccountPoolBridge(bridge) ? bridge : null;
      if (poolBridge && !poolBridge.canThreadUseModel(request.params.threadId, input.model)) {
        return reply.code(409).send({ error: "这个会话绑定了原供应商运行时，不能直接切换到其他供应商。请从上一轮回答创建分支后再选择新模型。" });
      }
      const data = store.setThreadModelConfig(request.params.threadId, userId, input.model, input.reasoningEffort);
      if (!data) {
        return reply.code(404).send({ error: "Thread not found." });
      }
      return { data };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.put<{ Params: { id: string } }>("/api/projects/:id/threads/order", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      const input = threadOrderSchema.parse(request.body);
      const ownedThreadIds = store.ownedThreadIds(userId, project.id);
      if (input.threadIds.some((threadId) => !ownedThreadIds.has(threadId))) {
        return reply.code(404).send({ error: "Thread not found." });
      }
      store.setThreadOrder(userId, input.threadIds);
      const presentation = store.getThreadPresentation(userId, input.threadIds);
      return { data: input.threadIds.map((threadId) => presentation.get(threadId)).filter(Boolean) };
    } catch (error) {
      return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

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
      false
    );
    if (!unusedThread) {
      return reply.code(404).send({ error: "Thread not found." });
    }
    return { ok: true, data: unusedThread };
  });

  app.post<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/branch", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) return reply.code(404).send({ error: "Project not found." });
      if (!store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }
      const input = threadBranchSchema.parse(request.body ?? {});
      const targetProject = input.targetProjectId ? store.getProject(input.targetProjectId, userId) : project;
      if (!targetProject) return reply.code(404).send({ error: "Target project not found." });
      // Resolve the source account and metadata cheaply first. Native forks do
      // not need to hydrate a potentially hundreds-of-megabytes history in
      // Node; Codex performs the exact fork inside the owning app-server.
      const poolBridge = isAccountPoolBridge(bridge) ? bridge : null;
      const persistedSourcePath = await findThreadJsonlPathById(request.params.threadId);
      let sourceThread: Record<string, unknown>;
      try {
        const source = await bridge.request("thread/read", { threadId: request.params.threadId, includeTurns: false }, 60_000);
        sourceThread = asRecord(asRecord(source).thread);
      } catch (error) {
        // A retired/disabled account cannot answer thread/read, but its exact
        // immutable JSONL remains a valid native-fork source for an active account.
        if (!poolBridge || !persistedSourcePath) throw error;
        sourceThread = asRecord(await readThreadSummaryFromJsonl(persistedSourcePath, request.params.threadId));
        sourceThread.path = persistedSourcePath;
      }
      const storedPin = store.getThreadContextPin(request.params.threadId, userId)?.text ?? "";
      const manualPin = isLegacyGeneratedBranchPin(storedPin) ? "" : storedPin;
      const owner = store.getThreadOwner(request.params.threadId);
      const sourceContextConfig = store.getThreadContextConfig(request.params.threadId, userId)
        ?? defaultThreadContextConfig(request.params.threadId);
      const sourceContextUsage = await readThreadContextUsage(request.params.threadId, sourceContextConfig);
      const presentation = store.getThreadPresentation(userId, [request.params.threadId]).get(request.params.threadId);
      const model = presentation?.model ?? owner?.modelOverride ?? project.defaultModel;
      const reasoningEffort = presentation?.reasoningEffort ?? owner?.reasoningEffortOverride ?? project.defaultReasoningEffort;
      const contextConfig = threadContextConfigOverrides(
        sourceContextConfig,
        contextWindowMeasuredForConfig(sourceContextConfig, sourceContextUsage)
      );
      const allowedAccountId = allowedAccountForUser(userId);
      if (allowedAccountId && (!poolBridge || !poolBridge.hasAccount(allowedAccountId))) {
        throw new Error(`${userId} 的专用账号 ${allowedAccountId} 当前不可用。`);
      }
      const routing = poolBridge?.getBranchRoutingDecision(request.params.threadId, model, allowedAccountId ?? undefined) ?? null;
      const nativeFork = !routing || routing.mode === "native";
      const forkParams = {
        threadId: request.params.threadId,
        lastTurnId: input.turnId,
        cwd: targetProject.rootPath,
        model,
        approvalPolicy: targetProject.defaultApprovalPolicy,
        sandbox: targetProject.defaultSandbox,
        threadSource: "user",
        config: contextConfig,
        excludeTurns: true,
        deferGoalContinuation: true
      };

      // Cross-account branches are still native Codex forks. The source JSONL
      // is exposed to the selected target through a private immutable snapshot;
      // no summary or reconstructed prompt is substituted for model history.
      let snapshot: Awaited<ReturnType<typeof createCrossAccountForkSnapshot>> | null = null;
      let started: unknown;
      try {
        if (!poolBridge || !routing) {
          started = await bridge.request("thread/fork", forkParams, 60_000);
        } else if (nativeFork) {
          started = await poolBridge.forkThreadOnAccount(routing.targetAccount.id, forkParams, 60_000);
        } else {
          const sourcePath = stringOrNull(sourceThread.path) ?? stringOrNull(sourceThread.rolloutPath);
          const sourceSessionsRoot = sourcePath
            ? routing.sourceAccount
              ? path.join(routing.sourceAccount.codexHome, "sessions")
              : threadJsonlSessionsRoot(sourcePath)
            : null;
          if (!sourcePath || !sourceSessionsRoot) {
            throw new Error("Codex did not expose the source session path for an exact cross-account branch.");
          }
          snapshot = await createCrossAccountForkSnapshot(
            sourcePath,
            sourceSessionsRoot
          );
          started = await poolBridge.forkThreadOnAccount(routing.targetAccount.id, {
            ...forkParams,
            path: snapshot.path
          }, 60_000);
        }
      } finally {
        await snapshot?.remove();
      }
      const createdThread = asRecord(asRecord(started).thread);
      const createdThreadId = stringOrNull(createdThread.id);
      if (!createdThreadId) throw new Error("Codex did not return a branch thread id.");

      store.registerThreadOwner({
        threadId: createdThreadId,
        userId,
        projectId: targetProject.id,
        rootPath: targetProject.rootPath,
        model,
        reasoningEffort
      });
      const targetAccount = poolBridge?.getKnownThreadAccount(createdThreadId)
        ?? (routing ? { id: routing.targetAccount.id, label: routing.targetAccount.label } : null);
      const name = branchTitle(
        presentation?.displayName ?? stringOrNull(sourceThread.name) ?? stringOrNull(sourceThread.preview) ?? "会话",
        targetAccount?.label ?? null,
        routing?.sourceAccount?.label ?? null
      );
      store.updateThreadDisplayName(createdThreadId, userId, name);
      // Only user-authored pins remain durable; legacy generated handoff pins
      // are intentionally not inherited by new native branches.
      if (manualPin) store.setThreadContextPin(createdThreadId, userId, manualPin);
      store.setThreadContextConfig(createdThreadId, userId, {
        profile: sourceContextConfig.profile,
        contextWindow: sourceContextConfig.contextWindow,
        compactTokenLimit: sourceContextConfig.compactTokenLimit,
        scope: sourceContextConfig.scope
      });
      createdThread.name = name;
      createdThread.title = name;
      void bridge.request("thread/name/set", { threadId: createdThreadId, name }).catch((error) => {
        console.warn("Native Codex branch title failed", error);
      });

      const turn = input.prompt ? await bridge.request("turn/start", {
        threadId: createdThreadId,
        // Only a prompt explicitly supplied by the caller starts a new turn.
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: targetProject.rootPath,
        approvalPolicy: targetProject.defaultApprovalPolicy,
        sandboxPolicy: targetProject.defaultSandbox === "danger-full-access"
          ? { type: "dangerFullAccess" }
          : targetProject.defaultSandbox === "read-only"
            ? { type: "readOnly", networkAccess: false }
            : { type: "workspaceWrite", writableRoots: [targetProject.rootPath], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        model,
        effort: reasoningEffort,
        config: threadTurnContextConfigOverrides(
          sourceContextConfig,
          contextWindowMeasuredForConfig(sourceContextConfig, sourceContextUsage)
        )
      }, 60_000) : null;
      store.touchThreadOwner(createdThreadId);
      return {
        data: {
          thread: createdThread,
          turn,
          sourceThreadId: request.params.threadId,
          sourceTurnId: input.turnId,
          targetAccount,
          branchMode: nativeFork ? "native" : "cross-account-native"
        }
      };
    } catch (error) {
      console.warn("Native Codex branch request failed", {
        threadId: request.params.threadId,
        error: error instanceof Error ? error.message : String(error)
      });
      return reply.code(errorStatus(error) === 500 ? 502 : errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/review", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) return reply.code(404).send({ error: "Project not found." });
      if (!store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }
      const input = z.object({ branch: z.string().trim().min(1).max(120).optional() }).strict().parse(request.body ?? {});
      const target = input.branch
        ? { type: "baseBranch", branch: input.branch }
        : { type: "uncommittedChanges" };
      await assertTrackedUserQuotaAvailable(bridge, store, userId, request.params.threadId);
      await bridge.request("thread/resume", {
        threadId: request.params.threadId,
        cwd: project.rootPath,
        approvalPolicy: project.defaultApprovalPolicy,
        sandbox: project.defaultSandbox
      }, 30_000);
      const result = await bridge.request("review/start", {
        threadId: request.params.threadId,
        target,
        delivery: "inline"
      }, 60_000);
      store.touchThreadOwner(request.params.threadId);
      return { data: result };
    } catch (error) {
      return reply.code(errorStatus(error) === 500 ? 502 : errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { id: string; threadId: string } }>("/api/projects/:id/threads/:threadId/edit-latest", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = store.getProject(request.params.id, userId);
      if (!project) return reply.code(404).send({ error: "Project not found." });
      if (!store.userCanAccessThread(request.params.threadId, userId, project.id)) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }
      const { turnId } = z.object({ turnId: z.string().min(1) }).strict().parse(request.body ?? {});
      const summary = await bridge.request("thread/read", { threadId: request.params.threadId, includeTurns: false }, 30_000);
      const historyMode = asRecord(asRecord(summary).thread).historyMode;
      const goalState = await bridge.request("thread/goal/get", { threadId: request.params.threadId }, 30_000) as { goal?: { status?: string } | null };
      if (goalState?.goal?.status === "active") {
        return reply.code(409).send({ error: "当前 Goal 仍在自动续跑；请先暂停或结束 Goal，再编辑最后一条提问。" });
      }
      const queued = await bridge.request("thread/queue/list", { threadId: request.params.threadId, limit: 1 }, 30_000) as { data?: unknown[] };
      if (queued?.data?.length) {
        return reply.code(409).send({ error: "当前会话还有排队消息；请先处理排队消息，再编辑最后一条提问。" });
      }
      if (historyMode === "legacy" && isAccountPoolBridge(bridge)) {
        // The guarded compatibility path stops only an idle owning runtime,
        // appends the Codex replay marker, and verifies/reverses it on failure.
        // Do not call paginated turns/list or revert for a legacy rollout.
        const result = await bridge.rollbackLegacyLatest(request.params.threadId, turnId);
        store.touchThreadOwner(request.params.threadId);
        const rolloutPath = asRecord(asRecord(result).thread).path;
        if (typeof rolloutPath === "string") {
          // Complete the local history projection before acknowledging edit.
          // A projection error must not imply that the successful rollback
          // failed and invite the client to roll back a second turn.
          await warmThreadIndex(rolloutPath, request.params.threadId).catch((error) => {
            console.warn("Could not refresh history after legacy rollback", { threadId: request.params.threadId, error });
          });
        }
        return { data: result };
      }
      if (historyMode !== "paginated") {
        return reply.code(409).send({ error: "当前运行时不支持安全撤回此会话；草稿和附件仍保留。" });
      }
      const latest = await bridge.request("thread/turns/list", {
        threadId: request.params.threadId,
        limit: 1,
        sortDirection: "desc"
      }, 30_000) as { data?: Array<{ id?: string; status?: string }> };
      const lastTurn = latest.data?.[0];
      if (!lastTurn || lastTurn.id !== turnId) {
        return reply.code(409).send({ error: "只能撤回当前会话最后一轮；请刷新后重试。" });
      }
      if (lastTurn.status !== "completed" && lastTurn.status !== "failed" && lastTurn.status !== "interrupted") {
        return reply.code(409).send({ error: "这轮仍在运行，请等待完成后再撤回。" });
      }
      // Paginated revert operates on a loaded thread. This does not undo
      // filesystem changes made during that turn.
      await bridge.request("thread/resume", {
        threadId: request.params.threadId,
        cwd: project.rootPath,
        approvalPolicy: project.defaultApprovalPolicy,
        sandbox: project.defaultSandbox
      }, 30_000);
      const result = await bridge.request("thread/revert", { threadId: request.params.threadId, beforeTurnId: turnId }, 60_000);
      store.touchThreadOwner(request.params.threadId);
      return { data: result };
    } catch (error) {
      if (error instanceof Error && error.message.includes("thread/revert only supports paginated threads")) {
        return reply.code(409).send({
          code: "LEGACY_ROLLBACK_UNAVAILABLE",
          error: "这条会话使用 Codex 默认的 legacy 历史格式；当前运行的 Codex 版本没有可安全撤回此格式最后一轮的接口。原记录未改动。"
        });
      }
      return reply.code(errorStatus(error) === 500 ? 502 : errorStatus(error)).send({ error: error instanceof Error ? error.message : String(error) });
    }
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
        project.id
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
        ? await sendFileToLocalViaSsh(settingsForCurrentAccessDevice(settings, request, userId), target.filePath, input.destinationPath)
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

  app.get<{ Params: { threadId: string }; Querystring: { projectId?: string; before?: string; cursor?: string; fresh?: string; limit?: string } }>("/api/threads/:threadId", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      const userId = userIdFromRequest(request, store);
      const input = threadReadQuerySchema.parse(request.query ?? {});
      const project = input.projectId ? store.getProject(input.projectId, userId) : null;
      if (input.projectId && !project) {
        return reply.code(404).send({ error: "Project not found." });
      }
      if (!store.userCanAccessThread(
        request.params.threadId,
        userId,
        project?.id
      )) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }

      const presentation = store.getThreadPresentation(userId, [request.params.threadId]).get(request.params.threadId);
      const modelPresentation = resolvedThreadModelPresentation(store, userId, request.params.threadId, presentation);

      let result: unknown;
      // Persisted JSONL is local, paginated and independent of the shared Codex
      // app-server queue. Prefer it for every existing session, not only huge ones.
      const fallbackPath = await findThreadJsonlPathById(request.params.threadId);
      if (fallbackPath) {
        const indexedPage = await readIndexedThreadPage(fallbackPath, request.params.threadId, {
          before: input.before,
          cursor: input.cursor,
          limit: input.limit,
          backgroundRefresh: !input.fresh && input.before === 0 && !input.cursor
        });
        result = { thread: overlayJournal(indexedPage.thread as Record<string, unknown>, (turnId) => store.readTimelineItems(request.params.threadId, turnId), input.before === 0 && !input.cursor) };
        result = sanitizeThreadPayloadForClient(result);
        const clientThread = asRecord(result).thread;
        deferLargeToolOutputs(clientThread);
        return {
          thread: applyThreadPresentation(clientThread, presentation, modelPresentation),
          history: indexedPage.history
        };
      } else {
        result = await bridge.request("thread/read", {
          threadId: request.params.threadId,
          includeTurns: true
        });
        result = await readThreadPreferJsonlFallback(request.params.threadId, result);
      }
      result = sanitizeThreadPayloadForClient(result);
      const page = paginateThreadPayload(result, input.before, input.limit);
      return {
        ...page,
        thread: applyThreadPresentation(page.thread, presentation, modelPresentation)
      };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { threadId: string }; Querystring: { projectId?: string; itemId?: string } }>("/api/threads/:threadId/position", async (request, reply) => {
    try {
      const userId = userIdFromRequest(request, store);
      const project = request.query.projectId ? store.getProject(request.query.projectId, userId) : null;
      if (request.query.projectId && !project) return reply.code(404).send({ error: "Project not found." });
      if (!store.userCanAccessThread(request.params.threadId, userId, project?.id)) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }
      const itemId = request.query.itemId?.trim();
      if (!itemId) return reply.code(400).send({ error: "itemId is required." });
      const filePath = await findThreadJsonlPathById(request.params.threadId);
      if (!filePath) return reply.code(404).send({ error: "Thread history file not found." });
      await warmThreadIndex(filePath, request.params.threadId);
      const position = locateIndexedThreadItem(request.params.threadId, itemId);
      return position ? { data: position } : reply.code(404).send({ error: "Message was not found in the thread index." });
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { threadId: string; itemId: string }; Querystring: { projectId?: string } }>("/api/threads/:threadId/items/:itemId/output", async (request, reply) => {
    try {
      reply.header("Cache-Control", "private, max-age=300");
      const userId = userIdFromRequest(request, store);
      const project = request.query.projectId ? store.getProject(request.query.projectId, userId) : null;
      if (request.query.projectId && !project) return reply.code(404).send({ error: "Project not found." });
      if (!store.userCanAccessThread(request.params.threadId, userId, project?.id)) {
        return reply.code(403).send({ error: "Thread is not visible for this logged-in user." });
      }
      const filePath = await findThreadJsonlPathById(request.params.threadId);
      const indexedItem = filePath ? await readIndexedThreadItem(filePath, request.params.threadId, request.params.itemId) : null;
      const item = indexedItem ?? store.readTimelineItem(request.params.threadId, request.params.itemId);
      if (!item) return reply.code(404).send({ error: "Tool output was not found in the thread index." });
      const output = typeof item.aggregatedOutput === "string"
        ? item.aggregatedOutput
        : typeof item.output === "string" ? item.output : "";
      return { data: { output, bytes: Buffer.byteLength(output) } };
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
