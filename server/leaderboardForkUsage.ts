import fs from "node:fs";
import { createInterface } from "node:readline";

const turnCache = new Map<string, { size: number; mtimeMs: number; ids: Set<string> }>();

/** Forks copy old token_count records, sometimes with rewritten timestamps.
 * Stable turn IDs, not import timestamps, identify already-billed work. */
export async function inheritedBillingTurnIds(filePath: string): Promise<Set<string>> {
  const stat = fs.statSync(filePath);
  const cached = turnCache.get(filePath);
  if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.ids;
  const ids = new Set<string>();
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "turn_context" || (row.type === "event_msg" && row.payload?.type === "task_started")) {
      if (typeof row.payload?.turn_id === "string") ids.add(row.payload.turn_id);
    }
  }
  if (turnCache.size >= 128) turnCache.delete(turnCache.keys().next().value!);
  turnCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, ids });
  return ids;
}
