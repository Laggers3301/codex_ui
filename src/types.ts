export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ModelProfile {
  id: string;
  label: string;
  model: string;
  effort: ReasoningEffort;
  displayName?: string;
  priority?: number;
}

export interface CodexRateLimitWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
  individualLimit: { limit: string | null; used: string | null; remainingPercent: number | null; resetsAt: number | null } | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface CodexQuota {
  account: { type: string | null; planType: string | null } | null;
  rateLimits: CodexRateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot>;
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
}

export interface CodexTokenBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexLeaderboardModelUsage extends CodexTokenBreakdown {
  model: string;
  effort: string | null;
  sessionCount: number;
}

export interface CodexLeaderboardUserUsage extends CodexTokenBreakdown {
  userId: string;
  sharePercent: number;
  quotaPercent: number | null;
  sessionCount: number;
  models: CodexLeaderboardModelUsage[];
}

export interface CodexLeaderboardScope {
  totalTokens: number;
  resetAt: number | null;
  resetWindowMins: number | null;
  startAt: number | null;
  quotaUsedPercent: number | null;
  users: CodexLeaderboardUserUsage[];
}

export interface CodexLeaderboard {
  currentCycle: CodexLeaderboardScope;
  lifetime: CodexLeaderboardScope;
  updatedAt: string;
  errors: string[];
}

export interface CodexSkill {
  name: string;
  displayName: string;
  shortDescription: string | null;
  description: string;
  scope: string | null;
  enabled: boolean;
  defaultPrompt: string | null;
}

export interface CodexSkillsResponse {
  data: CodexSkill[];
  errors: Array<{ cwd: string; path: string; message: string }>;
}


export interface LocalSendSettings {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  destinationPath: string;
  identityFile: string;
  outputPath: string;
  updatedAt: string | null;
}

export interface LocalSendTestResult {
  sshHost: string;
  sshUser: string;
  sshPort: number;
  destinationPath: string;
}

export interface LocalSendResult {
  sourcePath: string;
  relativePath: string;
  name: string;
  size: number;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  destinationPath: string;
  remoteFile: string;
  stdout?: string;
  stderr?: string;
}

export type ThreadExportFormat = "markdown" | "json";

export interface ThreadExportResult {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  mime: string;
  rawUrl: string;
  format: ThreadExportFormat;
  outputPath: string;
  sentLocal?: LocalSendResult;
}

export interface SessionMigrationResult {
  sourceLabel: string;
  projectId: string | null;
  projectName: string | null;
  sourceOwnedThreadCount: number;
  sourceSessionCount: number;
  importedThreadIds: string[];
  alreadyPresentThreadIds: string[];
  skippedThreadIds: string[];
}

export interface UserProfile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  rootPath: string;
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  defaultSandbox: SandboxMode;
  defaultApprovalPolicy: ApprovalPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  relativePath: string;
}

export interface DirectoryListResponse {
  rootPath: string;
  currentPath: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
}

export interface ThreadSummary {
  id: string;
  sessionId: string;
  preview: string;
  name: string | null;
  pinned?: boolean;
  configuredModel?: string | null;
  configuredReasoningEffort?: ReasoningEffort | null;
  cwd: string;
  updatedAt: number;
  createdAt: number;
  status: unknown;
  turns: Turn[];
}

export interface ThreadPresentation {
  threadId: string;
  pinned: boolean;
  manualOrder: number | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

export interface Turn {
  id: string;
  status: unknown;
  startedAt: number | null;
  completedAt: number | null;
  items: ThreadItem[];
  userMessage?: unknown;
  prompt?: unknown;
  input?: unknown;
  message?: unknown;
  request?: unknown;
  submission?: unknown;
  [key: string]: unknown;
}

export type ThreadItem = {
  type: string;
  id: string;
  role?: string;
  text?: string;
  message?: unknown;
  input?: unknown;
  prompt?: unknown;
  output?: unknown;
  value?: unknown;
  content?: unknown;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown[];
  server?: string;
  tool?: string;
  query?: string;
  summary?: string[];
  [key: string]: unknown;
};

export interface ThreadReadResponse {
  thread: ThreadSummary;
  history?: ThreadHistoryPage;
}

export interface ThreadHistoryPage {
  totalItems: number;
  returnedItems: number;
  before: number;
  nextBefore: number;
  hasOlder: boolean;
}

export interface ThreadListResponse {
  data: ThreadSummary[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface SocketMessage {
  type: string;
  requestId?: string;
  ok?: boolean;
  data?: unknown;
  error?: string;
}

export interface CodexNotification {
  method?: string;
  params?: Record<string, unknown>;
}

export interface LiveAgentMessage {
  itemId: string;
  threadId: string | null;
  turnId: string | null;
  text: string;
  completed: boolean;
  startedAt: string;
  updatedAt: string;
}

export interface LiveTurnState {
  threadId: string | null;
  turnId: string | null;
  status: "running" | "completed";
  startedAt: string;
  updatedAt: string;
}

export interface LiveToolItem {
  itemId: string;
  threadId: string | null;
  turnId: string | null;
  tool: string;
  input: string;
  output: string;
  completed: boolean;
  startedAt: string;
  updatedAt: string;
}

export interface LiveStateSnapshot {
  agentMessages: LiveAgentMessage[];
  toolItems: LiveToolItem[];
  activeTurns: LiveTurnState[];
  updatedAt: string | null;
}

export interface ProjectFile {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  mime: string;
  rawUrl: string;
  uploadDir?: string;
}

export interface ProjectFilePreview extends ProjectFile {
  line: number | null;
  kind: "markdown" | "text" | "image" | "pdf" | "binary";
  truncated: boolean;
  content?: string;
}
