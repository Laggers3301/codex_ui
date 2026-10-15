import fs from "node:fs";
import path from "node:path";
import type { CodexBridge } from "./codexBridge.js";

export const runtimeSelectionPath = (home: string) => path.join(home, ".web-runtime-version.json");
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
export async function runtimeIsIdle(bridge: CodexBridge): Promise<boolean> {
  const loaded = await bridge.request("thread/loaded/list", {}, 10_000) as { data?: unknown };
  if (!Array.isArray(loaded.data) || loaded.data.length > 200) return false;
  for (const threadId of loaded.data) {
    if (typeof threadId !== "string") return false;
    const read = await bridge.request("thread/read", { threadId, includeTurns: false }, 10_000) as any;
    if (read?.thread?.status?.type !== "idle") return false;
    const goal = await bridge.request("thread/goal/get", { threadId }, 10_000) as any;
    if (!("goal" in goal) || goal.goal?.status === "active") return false;
    const queue = await bridge.request("thread/queue/list", { threadId, limit: 1 }, 10_000) as any;
    if (!Array.isArray(queue.data) || queue.data.length || queue.nextCursor) return false;
    const terminals = await bridge.request("thread/backgroundTerminals/list", { threadId, limit: 1 }, 10_000) as any;
    if (!Array.isArray(terminals.data) || terminals.data.length || terminals.nextCursor) return false;
  }
  return !bridge.getPendingServerRequests().length;
}
export function writeRuntimeSelection(home: string, version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid Codex version");
  const file = runtimeSelectionPath(home), temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version, selectedAt: new Date().toISOString() }), {mode:0o600});
  fs.renameSync(temporary,file);
}
