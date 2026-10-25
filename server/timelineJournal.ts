import type { LiveStateUpdate } from "./liveState.js";
import { isContextCompactionItem } from "./contextRecovery.js";

type Item = Record<string, unknown>;

export function journalItem(update: LiveStateUpdate): Item {
  const item = update.item;
  if (update.kind === "reasoning") return { id: update.item.itemId, type: "reasoning", text: update.item.text, summary: [update.item.text], completed: item.completed, timelineAt: item.startedAt, timelineOrder: item.sequence };
  return update.kind === "tool"
    ? { id: item.itemId, callId: item.itemId, sourceItemId: update.item.sourceItemId, type: "toolCall", tool: update.item.tool, collaboration: update.item.collaboration, input: (update.historyItem ?? update.item).input, aggregatedOutput: (update.historyItem ?? update.item).output, completed: item.completed, timelineAt: item.startedAt, timelineOrder: item.sequence }
    : { id: update.item.sourceItemId, type: "agentMessage", text: update.item.text, completed: item.completed, streamState: update.item.streamState ?? (item.completed ? "completed" : "streaming"), timelineAt: item.startedAt, timelineOrder: item.sequence };
}

/** Enrich only the loaded history interval, not unseen pages of a long turn. */
export function overlayJournal(thread: Item, read: (turnId: string) => Item[], includeTail: boolean): Item {
  const turns = Array.isArray(thread.turns) ? thread.turns as Item[] : [];
  return { ...thread, turns: turns.map((turn, turnIndex) => {
    const items = Array.isArray(turn.items) ? turn.items as Item[] : [];
    const times = items.map((item) => Date.parse(String(item.timelineAt ?? ""))).filter(Number.isFinite);
    const first = times.length ? Math.min(...times) : 0;
    const last = includeTail && turnIndex === turns.length - 1 ? Infinity : times.length ? Math.max(...times) : Infinity;
    const byId = new Map<string, Item>();
    // Output records share callId but are not invocation identities.
    for (const item of items) if (item.type !== "toolCallOutput") {
      byId.set(String(item.id), item);
      if (item.callId) byId.set(String(item.callId), item);
      if (item.sourceItemId) byId.set(String(item.sourceItemId), item);
    }
    const merged: Item[] = items.map((item) => ({ ...item, ...(item.type === "agentMessage" ? { streamState: "completed", completed: true } : {}) }));
    for (const entry of read(String(turn.id))) {
      if (isContextCompactionItem(entry)) {
        continue;
      }
      if (entry.source === "turnDiff" && items.some((item) => item.type === "fileChange"
        && Array.isArray(item.changes) && item.changes.some((change) => typeof (change as Item)?.diff === "string"))) {
        continue;
      }
      const existing = byId.get(String(entry.id)) ?? byId.get(String(entry.sourceItemId));
      if (existing && existing.type !== "toolCallOutput") {
        const index = items.indexOf(existing);
        merged[index] = { ...entry, ...merged[index], timelineAt: entry.timelineAt, timelineOrder: entry.timelineOrder };
        if (entry.type === "reasoning" && typeof entry.text === "string" && entry.text.trim()) {
          // Native history can still contain the empty item-start snapshot.
          const native = items[index];
          const summary = Array.isArray(native.summary) ? native.summary.map(p => typeof p === "string" ? p : String((p as Item)?.text ?? "")).join("\n\n") : String(native.text ?? "");
          if (entry.completed || entry.text.length > summary.length) merged[index] = { ...merged[index], text: entry.text, summary: [entry.text], completed: entry.completed };
        }
      } else {
        const time = Date.parse(String(entry.timelineAt));
        if (entry.source === "turnDiff" || (time >= first && time <= last)) {
          // Old journals did not store completion. A journal-only draft inside
          // the loaded native interval, before a later committed message, is
          // not a committed response. Keep its bytes, retire only its display.
          const replacedDraft = entry.type === "agentMessage" && entry.completed !== true
            && Number.isFinite(time) && items.some(item => item.type === "agentMessage"
              && Date.parse(String(item.timelineAt ?? "")) > time);
          merged.push(replacedDraft ? { ...entry, streamState: "superseded" } : entry);
        }
      }
    }
    merged.sort((a, b) => Date.parse(String(a.timelineAt)) - Date.parse(String(b.timelineAt)) || Number(a.timelineOrder ?? 0) - Number(b.timelineOrder ?? 0));
    return { ...turn, items: merged };
  }) };
}
