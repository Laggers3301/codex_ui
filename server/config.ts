import path from "node:path";

function booleanFromEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function csvFromEnv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim().replace(/\/+$/, "")).filter(Boolean);
}

function positiveIntegerFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const serverConfig = {
  host: process.env.CODEX_WEB_HOST ?? "0.0.0.0",
  port: Number(process.env.CODEX_WEB_PORT ?? 4576),
  projectRoot: path.resolve(process.env.CODEX_WEB_PROJECT_ROOT ?? process.cwd()),
  dataDir: path.resolve(process.env.CODEX_WEB_DATA_DIR ?? ".codex-web"),
  codexBin: process.env.CODEX_WEB_CODEX_BIN ?? "codex",
  accountPoolFile: process.env.CODEX_WEB_ACCOUNT_POOL_FILE ?? "",
  allowOutsideProjectRoot: booleanFromEnv(process.env.CODEX_WEB_ALLOW_OUTSIDE_PROJECT_ROOT),
  authUser: process.env.CODEX_WEB_AUTH_USER ?? "",
  authPassword: process.env.CODEX_WEB_AUTH_PASSWORD ?? "",
  authMode: process.env.CODEX_WEB_AUTH_MODE ?? "member",
  defaultAuthPassword: process.env.CODEX_WEB_DEFAULT_PASSWORD ?? "",
  authUsersFile: process.env.CODEX_WEB_AUTH_USERS_FILE ?? "",
  // Other Codex Web instances that contribute to the shared token leaderboard.
  leaderboardPeers: csvFromEnv(process.env.CODEX_WEB_LEADERBOARD_PEERS),
  leaderboardPeerToken: process.env.CODEX_WEB_LEADERBOARD_PEER_TOKEN ?? "",
  leaderboardAccountLabel: process.env.CODEX_WEB_LEADERBOARD_ACCOUNT_LABEL ?? "default",
  leaderboardPeerLabels: csvFromEnv(process.env.CODEX_WEB_LEADERBOARD_PEER_LABELS),
  trackedQuotaUser: (process.env.CODEX_WEB_TRACKED_QUOTA_USER ?? "").trim(),
  trackedQuotaDailyLimitPercent: positiveNumberFromEnv(process.env.CODEX_WEB_TRACKED_QUOTA_DAILY_LIMIT_PERCENT, 50),
  trackedQuotaAllowedAccountId: (process.env.CODEX_WEB_TRACKED_QUOTA_ALLOWED_ACCOUNT_ID ?? "").trim(),
  trackedQuotaTimeZone: process.env.CODEX_WEB_TRACKED_QUOTA_TIME_ZONE ?? "UTC",
  // Configured only on the receiving instance. The browser never receives this SSH
  // destination; it is used server-side after the logged-in user is resolved.
  handoffSourceHost: process.env.CODEX_WEB_HANDOFF_SOURCE_HOST ?? "",
  handoffSourceUser: process.env.CODEX_WEB_HANDOFF_SOURCE_USER ?? "",
  handoffSourceAppDir: process.env.CODEX_WEB_HANDOFF_SOURCE_APP_DIR ?? "",
  handoffSourceLabel: process.env.CODEX_WEB_HANDOFF_SOURCE_LABEL ?? process.env.CODEX_WEB_INSTANCE_LABEL ?? "远端主机",
  handoffTargetCodexHome: process.env.CODEX_WEB_HANDOFF_TARGET_CODEX_HOME ?? "",
  handoffTargetAccountId: process.env.CODEX_WEB_HANDOFF_TARGET_ACCOUNT_ID ?? "",
  handoffMaxBytes: positiveIntegerFromEnv(process.env.CODEX_WEB_HANDOFF_MAX_BYTES, 2 * 1024 * 1024 * 1024)
};

export const defaults = {
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  model: "gpt-5.5",
  reasoningEffort: "xhigh"
} as const;
