export interface TurnProgress {
  threadId: string;
  turnId: string;
  state: string;
  silentForMs: number;
}

export function readTurnProgress(value: unknown): TurnProgress | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.threadId !== "string" || typeof row.turnId !== "string" || typeof row.state !== "string") return null;
  return { threadId: row.threadId, turnId: row.turnId, state: row.state, silentForMs: typeof row.silentForMs === "number" && Number.isFinite(row.silentForMs) ? Math.max(0, row.silentForMs) : 0 };
}

export function turnProgressText(progress: TurnProgress | undefined): string {
  if (!progress) return "";
  if (progress.state === "waiting_approval") return "正在等待操作批准。";
  if (progress.state === "waiting_subagents") return "正在等待子代理状态更新，可在右栏查看各任务进展。";
  const minutes = Math.max(2, Math.floor(progress.silentForMs / 60_000));
  return `已约 ${minutes} 分钟没有新输出，正在核对运行状态。`;
}

export function updateTurnProgress(current: Record<string, TurnProgress>, userId: string, progress: TurnProgress, activeTurnId?: string): Record<string, TurnProgress> {
  if (activeTurnId && activeTurnId !== progress.turnId) return current;
  const key = `${userId}:${progress.threadId}`;
  if (["active", "completed", "failed", "interrupted"].includes(progress.state)) {
    if (current[key]?.turnId !== progress.turnId) return current;
    const next = { ...current };
    delete next[key];
    return next;
  }
  return { ...current, [key]: progress };
}
