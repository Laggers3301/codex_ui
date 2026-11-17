import { memberRealName } from "../shared/memberDirectory";
import type { CodexLeaderboardUserUsage } from "./types";

// Kept apart from LeaderboardPanel.tsx so App can format the export text without loading the panel UI.
export function leaderboardPersonName(user: Pick<CodexLeaderboardUserUsage, "userId" | "displayName">): string {
  return user.displayName?.trim() || memberRealName(user.userId) || `待核实（${user.userId}）`;
}

export function leaderboardPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)}%` : "—";
}
