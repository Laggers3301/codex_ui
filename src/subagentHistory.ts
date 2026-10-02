import { mergeTimelineItems } from "./conversationTimeline";
import { parseAgentOperation } from "./subagentPresentation";
import type { ThreadItem, ThreadSummary, Turn } from "./types";

export type SubagentRecordGroup = { key: string; turnId: string; items: ThreadItem[]; bundle: boolean };

/** Keep prose and delegation cards separate; only consecutive activity is bundled. */
export function groupSubagentRecordItems(turnId: string, items: ThreadItem[], previous: SubagentRecordGroup[] = []): SubagentRecordGroup[] {
  const oldKeys = new Map<string, string>();
  for (const row of previous) {
    if (row.turnId === turnId && row.bundle) for (const item of row.items) oldKeys.set(item.id, row.key);
  }
  const rows: SubagentRecordGroup[] = [];
  const usedKeys = new Set<string>();
  let pending: ThreadItem[] = [];
  const single = (item: ThreadItem) => rows.push({ key: `${turnId}:${item.id}`, turnId, items: [item], bundle: false });
  const flush = () => {
    if (!pending.length) return;
    if (pending.some(item => item.type.toLowerCase() !== "reasoning")) {
      // Retain the existing identity when either older calls are prepended or
      // live calls/a following answer are appended. Open bundles stay open.
      const key = pending.map(item => oldKeys.get(item.id)).find(key => key && !usedKeys.has(key)) ?? `${turnId}:tools:${pending[0].id}`;
      usedKeys.add(key);
      rows.push({ key, turnId, items: pending, bundle: true });
    } else pending.forEach(single);
    pending = [];
  };
  for (const item of items) {
    const type = item.type.toLowerCase();
    if (["reasoning", "toolcall", "filechange"].includes(type) && !parseAgentOperation(item)) pending.push(item);
    else { flush(); single(item); }
  }
  flush();
  return rows;
}

/** History pages and polling share IDs; neither may duplicate or reorder a turn. */
export function mergeSubagentHistory(older: ThreadSummary, newer: ThreadSummary): ThreadSummary {
  const turns = new Map<string, Turn>();
  for (const turn of [...older.turns, ...newer.turns]) {
    const previous = turns.get(turn.id);
    turns.set(turn.id, previous ? { ...previous, ...turn, items: mergeTimelineItems(previous.items, turn.items) } : turn);
  }
  return { ...older, ...newer, turns: [...turns.values()] };
}
