import path from "node:path";

function booleanFromEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function csvFromEnv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim().replace(/\/+$/, "")).filter(Boolean);
}

export const serverConfig = {
  host: process.env.CODEX_WEB_HOST ?? "0.0.0.0",
  port: Number(process.env.CODEX_WEB_PORT ?? 4573),
  projectRoot: path.resolve(process.env.CODEX_WEB_PROJECT_ROOT ?? "/Volumes/DevDrive/program"),
  dataDir: path.resolve(process.env.CODEX_WEB_DATA_DIR ?? ".codex-web"),
  codexBin: process.env.CODEX_WEB_CODEX_BIN ?? "codex",
  allowOutsideProjectRoot: booleanFromEnv(process.env.CODEX_WEB_ALLOW_OUTSIDE_PROJECT_ROOT),
  authUser: process.env.CODEX_WEB_AUTH_USER ?? "",
  authPassword: process.env.CODEX_WEB_AUTH_PASSWORD ?? "",
  // Authentication is opt-in so an upstream install never inherits a shared
  // password. Configure it explicitly through environment variables.
  authMode: process.env.CODEX_WEB_AUTH_MODE ?? "off",
  defaultAuthPassword: process.env.CODEX_WEB_DEFAULT_PASSWORD ?? "",
  authUsersFile: process.env.CODEX_WEB_AUTH_USERS_FILE ?? "",
  // Other Codex Web instances that contribute to the shared token leaderboard.
  leaderboardPeers: csvFromEnv(process.env.CODEX_WEB_LEADERBOARD_PEERS),
  leaderboardPeerToken: process.env.CODEX_WEB_LEADERBOARD_PEER_TOKEN ?? "",
  leaderboardAccountLabel: process.env.CODEX_WEB_LEADERBOARD_ACCOUNT_LABEL ?? "",
  leaderboardPeerLabels: csvFromEnv(process.env.CODEX_WEB_LEADERBOARD_PEER_LABELS)
};

export const defaults = {
  sandbox: "danger-full-access",
  approvalPolicy: "never",
  model: "gpt-5.6-sol",
  reasoningEffort: "xhigh"
} as const;
