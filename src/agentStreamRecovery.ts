import type { AgentTextState } from "./liveAgentUpdates";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** Works with the raw native notifications, including already-running backends. */
export function recoverAgentStreams(entries: Iterable<[string, AgentTextState]>, event: { method?: string; params?: unknown }): Array<[string, AgentTextState]> {
  const error = event.method === "error";
  const finished = /^(?:item\/completed|item\/agentMessage\/completed)$/.test(event.method ?? "");
  if (!error && !finished) return [];
  const params = record(event.params), item = record(params.item);
  const threadId = params.threadId ?? params.thread_id, turnId = params.turnId ?? params.turn_id;
  if (typeof threadId !== "string" || typeof turnId !== "string") return [];
  const finalText = typeof item.text === "string" ? item.text : Array.isArray(item.content) ? item.content.map(part => {
    const p = record(part); return ["text", "output_text"].includes(String(p.type)) && typeof p.text === "string" ? p.text : "";
  }).join("") : "";
  if (finished && ((item.type !== "agentMessage" && event.method !== "item/agentMessage/completed") || !finalText || typeof item.id !== "string" || item.delivery === "async")) return [];
  const changes: Array<[string, AgentTextState]> = [];
  for (const [id, entry] of entries) {
    if (entry.threadId !== threadId || entry.turnId !== turnId || entry.completed || entry.streamState === "superseded") continue;
    if (error) changes.push([id, { ...entry, streamState: "interrupted" }]);
    else if (id === item.id || entry.sourceItemId === item.id) changes.push([id, { ...entry, text: finalText, completed: true, streamState: "completed" }]);
    else if (entry.streamState === "interrupted") changes.push([id, { ...entry, streamState: "superseded" }]);
  }
  return changes;
}
