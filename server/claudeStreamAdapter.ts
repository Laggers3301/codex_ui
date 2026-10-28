import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RpcEnvelope } from "./types.js";
import { redactModelError } from "../shared/modelError.js";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const string = (v: unknown): string => typeof v === "string" ? v : "";
const textContent = (v: unknown): string => typeof v === "string" ? v : Array.isArray(v)
  ? v.map(b => string(record(b).text) || JSON.stringify(b)).join("\n") : JSON.stringify(v ?? "");

interface Item extends RecordValue { id: string; type: string; }

/** Translate Claude SDK messages into the timeline envelopes already consumed
 * by LiveStateStore. Never execute tools here: Claude Code owns the agent loop. */
export class ClaudeStreamAdapter {
  readonly items = new Map<string, Item>();
  private messages = new Map<string, string>();
  private blocks = new Map<string, { item: Item; json: string; streamedText: boolean }>();
  private tools = new Map<string, Item>();
  private completedItems = new Set<string>();
  private seenMessages = new Set<string>();
  finished = false;
  sessionId: string | null = null;
  capabilities: { model: string; tools: string[]; skills: string[]; mcpServers: Array<{name: string; status: string}> } | null = null;

  constructor(readonly threadId: string, readonly turnId: string, private emit: (event: RpcEnvelope) => void) {}

  private notify(method: string, params: RecordValue): void {
    this.emit({ method, params: { threadId: this.threadId, turnId: this.turnId, ...params } });
  }

  start(): void {
    this.notify("turn/started", { turn: { id: this.turnId, status: "inProgress", items: [] } });
  }

  private upsert(id: string, block: RecordValue, parent: string): Item {
    let item = this.items.get(id);
    if (item) return item;
    const type = block.type === "text" ? "agentMessage" : block.type === "thinking" ? "reasoning" : "dynamicToolCall";
    item = { id, type, ...(parent ? { parentToolUseId: parent } : {}) };
    if (type === "agentMessage") item.text = "";
    else if (type === "reasoning") item.summary = [];
    else {
      item.tool = string(block.name);
      item.arguments = block.input ?? {};
      item.status = "inProgress";
      this.tools.set(`${parent}:${string(block.id)}`, item);
    }
    this.items.set(id, item);
    this.notify("item/started", { item: { ...item } });
    return item;
  }

  private complete(item: Item): void {
    if (this.completedItems.has(item.id)) return;
    this.completedItems.add(item.id);
    this.notify("item/completed", { item: { ...item } });
  }

  accept(message: SDKMessage | RecordValue): void {
    if (this.finished) return;
    const m = record(message);
    // UUIDs identify full SDK messages, including replayed snapshots. Stream
    // frames can share a UUID, so deduplicate only complete messages.
    if (m.type !== "stream_event" && typeof m.uuid === "string") {
      if (this.seenMessages.has(m.uuid)) return;
      this.seenMessages.add(m.uuid);
    }
    if (m.type === "system" && m.subtype === "init") {
      this.sessionId = string(m.session_id) || null;
      const strings = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
      this.capabilities = {
        model: string(m.model), tools: strings(m.tools), skills: strings(m.skills),
        mcpServers: Array.isArray(m.mcp_servers) ? m.mcp_servers.map(v => ({ name: string(record(v).name), status: string(record(v).status) })) : []
      };
      this.notify("runtime/initialized", { runtime: "claude-code", ...this.capabilities });
      return;
    }
    const parent = string(m.parent_tool_use_id);
    if (m.type === "stream_event") {
      const e = record(m.event);
      if (e.type === "message_start") this.messages.set(parent, string(record(e.message).id));
      const messageId = this.messages.get(parent);
      if (!messageId) return;
      const blockKey = `${parent}:${messageId}:${e.index}`;
      if (e.type === "content_block_start") {
        const b = record(e.content_block);
        if (!["text", "thinking", "tool_use"].includes(string(b.type))) return;
        const id = b.type === "tool_use" ? `claude-tool:${parent}:${string(b.id)}` : `claude-message:${blockKey}`;
        const item = this.upsert(id, b, parent);
        this.blocks.set(blockKey, { item, json: "", streamedText: false });
        const initial = string(b.text ?? b.thinking);
        if (initial) this.append(item, initial);
      } else if (e.type === "content_block_delta") {
        const b = this.blocks.get(blockKey), d = record(e.delta);
        if (!b) return;
        if (d.type === "text_delta" || d.type === "thinking_delta") {
          b.streamedText = true;
          this.append(b.item, string(d.text ?? d.thinking));
        } else if (d.type === "input_json_delta") {
          b.json += string(d.partial_json);
        }
      } else if (e.type === "content_block_stop") {
        const b = this.blocks.get(blockKey);
        if (!b) return;
        if (b.item.type === "dynamicToolCall") {
          if (b.json) {
            try { b.item.arguments = JSON.parse(b.json); } catch { /* Full assistant snapshot supplies the validated input. */ }
          }
          this.notify("item/started", { item: { ...b.item } });
        } else this.complete(b.item);
      }
      return;
    }
    if (m.type === "assistant") {
      const full = record(m.message);
      if (!Array.isArray(full.content) || !string(full.id)) return;
      full.content.forEach((v: unknown, index: number) => {
        const b = record(v);
        if (!["text", "thinking", "tool_use"].includes(string(b.type))) return;
        const id = b.type === "tool_use" ? `claude-tool:${parent}:${string(b.id)}` : `claude-message:${parent}:${string(full.id)}:${index}`;
        const item = this.upsert(id, b, parent);
        if (item.type === "dynamicToolCall") {
          item.arguments = b.input ?? {};
          if (!this.completedItems.has(id)) this.notify("item/started", { item: { ...item } });
        } else {
          // The final snapshot replaces streamed content, never appends it.
          if (item.type === "agentMessage") item.text = string(b.text);
          else item.summary = [string(b.thinking)];
          this.complete(item);
        }
      });
      return;
    }
    if (m.type === "user") {
      const content = record(m.message).content;
      if (!Array.isArray(content)) return;
      for (const value of content) {
        const b = record(value);
        if (b.type !== "tool_result") continue;
        const item = this.tools.get(`${parent}:${string(b.tool_use_id)}`);
        if (!item) continue;
        item.output = textContent(b.content);
        item.status = b.is_error ? "failed" : "completed";
        item.success = !b.is_error;
        this.complete(item);
      }
      return;
    }
    if (m.type === "result") {
      if (!this.sessionId) this.sessionId = string(m.session_id) || null;
      const success = m.subtype === "success" && m.is_error === false;
      // Some runtimes produce only a result, with no assistant snapshot.
      if (success && string(m.result) && ![...this.items.values()].some(i => i.type === "agentMessage" && !i.parentToolUseId)) {
        const item = this.upsert(`claude-result:${this.turnId}`, { type: "text" }, "");
        item.text = m.result; this.complete(item);
      }
      this.finish(success ? "completed" : "failed", success ? undefined : textContent(m.errors ?? m.result ?? m.subtype), m.usage);
    }
  }

  private append(item: Item, delta: string): void {
    if (!delta || this.completedItems.has(item.id)) return;
    if (item.type === "agentMessage") {
      item.text = string(item.text) + delta;
      this.notify("item/agentMessage/delta", { itemId: item.id, delta });
    } else {
      item.summary = [String((item.summary as string[])[0] ?? "") + delta];
      this.notify("item/reasoning/summaryTextDelta", { itemId: item.id, summaryIndex: 0, delta });
    }
  }

  finish(status: "completed" | "failed" | "interrupted", error?: string, usage?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    for (const item of this.items.values()) {
      if (item.type === "dynamicToolCall" && !this.completedItems.has(item.id)) {
        // Ending the stream is not evidence of a successful tool execution.
        item.status = "interrupted";
        item.output = "工具未返回结果，执行结果尚未确认。";
      }
      this.complete(item);
    }
    this.notify("turn/completed", { turn: {
      id: this.turnId, status, items: [...this.items.values()],
      error: error ? { message: redactModelError(error) } : null,
      ...(usage ? { usage } : {})
    } });
  }
}
