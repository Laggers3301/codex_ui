import fs from "node:fs";
import path from "node:path";
import type { CodexBridge } from "./codexBridge.js";

export const runtimeSelectionPath = (home: string) => path.join(home, ".web-runtime-version.json");
export type RuntimeUpgradeStage = "preflight" | "replacement" | "rollback";
export class RuntimeUpgradeFailure extends Error {
  constructor(readonly stage: RuntimeUpgradeStage, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RuntimeUpgradeFailure";
  }
}
export interface RuntimeUpgradeRetry {
  attempts: number;
  stage: RuntimeUpgradeStage;
  retryAt: number;
}
/** Failures cool down, but never permanently blacklist a validated version. */
export function nextRuntimeUpgradeRetry(previous: RuntimeUpgradeRetry | undefined, stage: RuntimeUpgradeStage, now = Date.now()): RuntimeUpgradeRetry {
  const attempts = previous?.stage === stage ? previous.attempts + 1 : 1;
  const base = stage === "preflight" ? 60_000 : stage === "replacement" ? 300_000 : 3_600_000;
  const cap = stage === "preflight" ? 900_000 : 3_600_000;
  return { attempts, stage, retryAt: now + Math.min(cap, base * 2 ** Math.min(attempts - 1, 6)) };
}
export function installedRuntimeVersion(home: string, fallback: string): string {
  try { const version=JSON.parse(fs.readFileSync(runtimeSelectionPath(home), "utf8")).version; if(typeof version==="string" && /^\d+\.\d+\.\d+$/.test(version))return version; }
  catch { /* fall back to the pinned launch version */ }
  return fallback.match(/\/codex-(\d+\.\d+\.\d+)\//)?.[1] ?? "0.0.0";
}
export function isNewerRuntime(next: string, current: string): boolean {
  if (![next, current].every(v => /^\d+\.\d+\.\d+$/.test(v))) return false;
  const a=next.split(".").map(Number), b=current.split(".").map(Number);
  for (let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];
  return false;
}
/** Fail closed: absence of a trustworthy idle/queue/goal/process result is busy. */
export interface RuntimeBusyReason { reason: string; threadId?: string; count?: number }
export async function runtimeIsIdle(bridge: CodexBridge, onBusy: (reason: RuntimeBusyReason) => void = () => {}): Promise<boolean> {
  const busy = (reason: string, threadId?: string, count?: number) => { onBusy({ reason, threadId, count }); return false; };
  const loaded = await bridge.request("thread/loaded/list", {}, 10_000) as { data?: unknown };
  if (!Array.isArray(loaded.data)) return busy("invalid_loaded_threads");
  if (loaded.data.length > 200) return busy("loaded_thread_limit", undefined, loaded.data.length);
  for (const threadId of loaded.data) {
    if (typeof threadId !== "string") return busy("invalid_thread_id");
    const read = await bridge.request("thread/read", { threadId, includeTurns: false }, 10_000) as any;
    if (read?.thread?.status?.type !== "idle") return busy(`thread_status_${read?.thread?.status?.type ?? "unknown"}`, threadId);
    let goal: any;
    try {
      goal = await bridge.request("thread/goal/get", { threadId }, 10_000);
    } catch (error) {
      // Ephemeral prediction/side threads cannot have persistent goals. This
      // exact capability error is not a runtime failure. Still check their
      // status, queued work, terminals and pending approvals below.
      if (!(error instanceof Error) || error.message !== `ephemeral thread does not support goals: ${threadId}`) throw error;
      goal = { goal: null };
    }
    if (!goal || !("goal" in goal) || goal.goal?.status === "active") return busy("goal_active_or_unknown", threadId);
    let queue: any;
    try {
      queue = await bridge.request("thread/queue/list", { threadId, limit: 1 }, 10_000);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== `ephemeral thread does not support queued submissions: ${threadId}`) throw error;
      queue = { data: [], nextCursor: null };
    }
    if (!Array.isArray(queue.data) || queue.data.length || queue.nextCursor) return busy("queued_work_or_unknown", threadId, queue.data?.length);
    const terminals = await bridge.request("thread/backgroundTerminals/list", { threadId, limit: 1 }, 10_000) as any;
    if (!Array.isArray(terminals.data) || terminals.data.length || terminals.nextCursor) return busy("background_terminals_or_unknown", threadId, terminals.data?.length);
  }
  return bridge.getPendingServerRequests().length ? busy("pending_approval") : true;
}

export function writeRuntimeSelection(home: string, version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid Codex version");
  const file = runtimeSelectionPath(home), temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version, selectedAt: new Date().toISOString() }), {mode:0o600});
  fs.renameSync(temporary,file);
}
