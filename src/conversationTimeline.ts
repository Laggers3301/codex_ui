import type { ThreadItem } from "./types";

export function correlationId(item: ThreadItem): string {
  return String(item.callId ?? item.call_id ?? item.toolCallId ?? item.tool_call_id ?? "");
}

export function timelineTime(item: ThreadItem): number {
  const value = Date.parse(String(item.timelineAt ?? item.startedAt ?? ""));
  return Number.isFinite(value) ? value : 0;
}

export function latestUserTimelineIndex(items: ThreadItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const type = String(item.type ?? "").toLowerCase();
    const role = String(item.role ?? "").toLowerCase();
    if (type === "usermessage" || type === "user" || role === "user") return index;
  }
  return -1;
}

/** One invocation owns its output, even if parallel calls finish out of order. */
export function coalesceToolOutputs(items: ThreadItem[]): ThreadItem[] {
  const calls = new Map<string, ThreadItem>();
  const copies = items.map((item) => ({ ...item }));
  let legacyPending: ThreadItem[] = [];
  for (const item of copies) {
    if (item.type.toLowerCase() === "toolcall") {
      calls.set(correlationId(item) || item.id, item);
      if (!correlationId(item)) legacyPending.push(item);
    } else if (item.type.toLowerCase() === "toolcalloutput") {
      const id = correlationId(item) || String(item.text ?? "");
      // Old API responses omitted callId on calls. A single outstanding serial
      // call can be associated unambiguously; never guess for parallel calls.
      if (id && !calls.has(id) && legacyPending.length === 1) {
        const call = legacyPending[0];
        call.sourceItemId ??= call.id;
        call.callId = id;
        call.id = id;
        calls.set(id, call);
      }
      legacyPending = [];
    } else {
      legacyPending = [];
    }
  }
  return copies.filter((item) => {
    if (item.type.toLowerCase() !== "toolcalloutput") return true;
    const call = calls.get(correlationId(item) || String(item.text ?? ""));
    if (call) {
      call.aggregatedOutput = item.aggregatedOutput ?? String(item.output ?? "");
      call.outputDeferred = item.outputDeferred;
      call.outputItemId = correlationId(item) || item.id;
      call.completedAt = item.timelineAt;
      call.completed = true;
      return false;
    }
    // Unmatched output stays at its source position; it is never a tail item.
    return true;
  });
}

function wrapperSource(item: ThreadItem): string {
  return String(item.input ?? item.command ?? "");
}

/**
 * Code-mode persists its outer `exec` in JSONL, while the live protocol emits
 * the concrete nested tools.  Showing both makes one invocation appear twice.
 * Replace a wrapper only when concrete children are durably present inside its
 * exact call/output interval; old JSONL-only calls therefore remain visible.
 */
export function collapseCodeModeWrappers(items: ThreadItem[]): ThreadItem[] {
  const nested = (item: ThreadItem) => item.type.toLowerCase() === "toolcall"
    && typeof item.sourceItemId === "string"
    && item.sourceItemId.startsWith("exec-");
  const hidden = new Set<ThreadItem>();
  for (const [wrapperIndex, wrapper] of items.entries()) {
    if (wrapper.type.toLowerCase() !== "toolcall" || String(wrapper.tool ?? "").toLowerCase() !== "exec" || !wrapperSource(wrapper).includes("tools.")) continue;
    const start = timelineTime(wrapper);
    const completedAt = Date.parse(String(wrapper.completedAt ?? ""));
    const nextBoundary = items.slice(wrapperIndex + 1).find((item) => !nested(item));
    const boundaryAt = nextBoundary ? timelineTime(nextBoundary) : Infinity;
    const end = Number.isFinite(completedAt) ? completedAt : boundaryAt || Infinity;
    if (!start) continue;
    const hasConcreteChild = items.some((item, index) => index > wrapperIndex && nested(item) && timelineTime(item) >= start && timelineTime(item) <= end);
    if (hasConcreteChild) hidden.add(wrapper);
  }
  return items.filter((item) => !hidden.has(item));
}

export function liveTimelineItems(entries: Array<{
  id: string; kind: "agent" | "tool"; sourceItemId?: string; startedAt: string; sequence: number;
  text?: string; tool?: string; input?: string; output?: string; completed?: boolean;
}>): ThreadItem[] {
  const items: ThreadItem[] = [];
  const agents = new Map<string, ThreadItem>();
  for (const entry of entries) {
    if (entry.kind === "tool") {
      items.push({ id: entry.id, callId: entry.id, sourceItemId: entry.sourceItemId, type: "toolCall", tool: entry.tool, input: entry.input, aggregatedOutput: entry.output, completed: entry.completed, timelineAt: entry.startedAt, timelineOrder: entry.sequence });
    } else {
      const id = entry.sourceItemId ?? entry.id;
      const existing = agents.get(id);
      if (existing) existing.text = `${existing.text ?? ""}${entry.text ?? ""}`;
      else {
        const item: ThreadItem = { id, type: "agentMessage", text: entry.text, timelineAt: entry.startedAt, timelineOrder: entry.sequence, timelineLive: true };
        items.push(item);
        agents.set(id, item);
      }
    }
  }
  return items;
}

export function mergeTimelineItems(history: ThreadItem[], updates: ThreadItem[]): ThreadItem[] {
  const canonical = (item: ThreadItem): ThreadItem => ({ ...item, sourceItemId: item.sourceItemId ?? item.id, id: item.type.toLowerCase() === "toolcall" ? correlationId(item) || item.id : item.id });
  const result = history.map(canonical);
  const known = new Map<string, ThreadItem>();
  const remember = (item: ThreadItem, index: number) => {
    known.set(item.id, item);
    if (typeof item.sourceItemId === "string") known.set(item.sourceItemId, item);
    if (item.type.toLowerCase() !== "toolcalloutput" && correlationId(item)) known.set(correlationId(item), item);
  };
  result.forEach(remember);
  const pending: ThreadItem[] = [];
  for (const raw of updates) {
    const item = canonical(raw);
    const previous = known.get(item.id) ?? known.get(String(item.sourceItemId)) ?? (item.type.toLowerCase() !== "toolcalloutput" && correlationId(item) ? known.get(correlationId(item)) : undefined);
    if (!previous) {
      pending.push(item);
      remember(item, 0);
    } else {
      // Shared messages/calls are order anchors even with an older server that
      // does not yet supply timestamps. Never append an earlier segment at tail.
      const index = result.indexOf(previous);
      if (index >= 0 && pending.length) result.splice(index, 0, ...pending.splice(0));
      const previousTime = timelineTime(previous), incomingTime = timelineTime(item);
      const timelineAt = previousTime && incomingTime
        ? (previousTime <= incomingTime ? previous.timelineAt : item.timelineAt)
        : previous.timelineAt ?? item.timelineAt;
      const merged: ThreadItem = { ...previous, ...item, id: previous.id, sourceItemId: previous.sourceItemId, timelineAt };
      if (previous.completed === true) merged.completed = true;
      for (const key of ["input", "command", "output", "aggregatedOutput", "text"] as const) {
        if (!item[key] && previous[key]) (merged as Record<string, unknown>)[key] = previous[key];
      }
      if (item.type === "agentMessage" && typeof previous.text === "string" && previous.text.startsWith(String(item.text ?? ""))) merged.text = previous.text;
      Object.assign(previous, merged);
    }
  }
  result.push(...pending);
  return result.sort((a, b) => {
    const at = timelineTime(a), bt = timelineTime(b);
    return at && bt ? at - bt || Number(a.timelineOrder ?? 0) - Number(b.timelineOrder ?? 0) : 0;
  });
}
