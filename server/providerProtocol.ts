import type { RpcEnvelope } from "./types.js";

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string | undefined => typeof v === "string" && v.length > 0 ? v : undefined;
const aliases: Record<string, string> = {
  agent_message: "agentMessage", function_call: "functionCall", custom_tool_call: "customToolCall",
  command_execution: "commandExecution", mcp_tool_call: "mcpToolCall", dynamic_tool_call: "dynamicToolCall"
};

/** Normalize explicit wire fields, never infer tools from prose or execute arguments.
 * Native app-server remains responsible for SSE decoding and tool execution. */
export function normalizeProviderNotification(event: RpcEnvelope): RpcEnvelope {
  const p = record(event.params);
  const item = record(p.item);
  const type = typeof item.type === "string" ? aliases[item.type] : undefined;
  const method = event.method?.replace(/^item\/(agent_message|command_execution|mcp_tool_call|dynamic_tool_call)\//,
    (_all, name: string) => `item/${aliases[name]}/`);
  const threadId = p.threadId ?? p.thread_id;
  const turnId = p.turnId ?? p.turn_id;
  const itemId = p.itemId ?? p.item_id;
  if (!type && method === event.method && threadId === p.threadId && turnId === p.turnId && itemId === p.itemId) return event;
  return { ...event, method, params: { ...p,
    ...(threadId !== undefined ? { threadId } : {}), ...(turnId !== undefined ? { turnId } : {}),
    ...(itemId !== undefined ? { itemId } : {}), ...(type ? { item: { ...item, type } } : {}) } };
}

/** A fatal native error is terminal only when the runtime explicitly says it
 * will not retry. Unknown errors and retrying streams must remain open. */
export class ProviderTurnProtocol {
  private active = new Map<string, string>();
  private finished = new Set<string>();
  accept(raw: RpcEnvelope): RpcEnvelope[] {
    const event = normalizeProviderNotification(raw);
    const p = record(event.params), turn = record(p.turn);
    const threadId = text(p.threadId) ?? text(record(p.thread).id) ?? text(turn.threadId);
    const turnId = text(p.turnId) ?? text(turn.id);
    const key = threadId && turnId ? JSON.stringify([threadId, turnId]) : undefined;
    if (event.method === "turn/started" && threadId && turnId) {
      // Do not resurrect an already-terminated turn from a delayed start event.
      if (key && this.finished.has(key)) return [];
      this.active.set(threadId, turnId);
    }
    if (event.method === "turn/completed" && key) {
      if (this.finished.has(key)) return [];
      this.finish(threadId!, turnId!, key);
    } else if (key && this.finished.has(key) && (event.method?.startsWith("item/") || event.method === "error")) {
      return [];
    }
    if (event.method === "error" && p.willRetry === false && threadId) {
      const id = turnId ?? this.active.get(threadId);
      if (id && this.active.get(threadId) === id) {
        const idKey = JSON.stringify([threadId, id]);
        this.finish(threadId, id, idKey);
        return [event, { ...event, method: "turn/completed", params: { threadId, turn: {
          id, status: "failed", error: p.error ?? { code: "provider_stream_failed", message: "模型输出流异常结束。" }
        }, protocolTerminal: true } }];
      }
    }
    return [event];
  }
  private finish(thread: string, turn: string, key: string): void {
    if (this.active.get(thread) === turn) this.active.delete(thread);
    this.finished.add(key);
    if (this.finished.size > 512) this.finished.delete(this.finished.values().next().value!);
  }
}
