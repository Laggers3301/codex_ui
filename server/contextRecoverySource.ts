import fs from "node:fs/promises";
import { isInternalUserMessageText } from "./internalUserMessage.js";

/** Bounded reverse scan: never load a whole rollout or a huge tool-result line. */
export async function readContextRecoverySource(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  const excerpts: Array<{ role: string; at: string; text: string }> = [];
  let bytes = 0, users = 0, answers = 0;
  const accept = (line: string) => {
    if (line.length > 131072) return;
    try {
      const record = JSON.parse(line), payload = record.payload ?? {};
      if (record.type !== "event_msg") return;
      const role = payload.type === "user_message" ? "user" : payload.type === "task_complete" ? "assistant" : "";
      const text = role === "user" ? payload.message : payload.last_agent_message;
      if (!role || typeof text !== "string" || !text.trim() || isInternalUserMessageText(text)) return;
      if (role === "user" ? users >= 8 : answers >= 3) return;
      const clipped = text.length > 6000 ? text.slice(0, 4500) + "\n[excerpt truncated; read source for full text]\n" + text.slice(-1500) : text;
      if (bytes + clipped.length > 30000) return;
      excerpts.push({ role, at: record.timestamp ?? "", text: clipped });
      bytes += clipped.length;
      if (role === "user") users++; else answers++;
    } catch { /* Partial, oversized and non-JSON records are not task context. */ }
  };
  try {
    let position = (await handle.stat()).size, scanned = 0;
    let suffix = "", discardSuffix = false;
    const chunk = Buffer.alloc(65536);
    while (position > 0 && scanned < 64 * 1024 * 1024 && !(users >= 8 && answers >= 3)) {
      const size = Math.min(chunk.length, position); position -= size; scanned += size;
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      // Decode complete lines only: buffer fragments can split UTF-8 characters.
      const raw = chunk.subarray(0, bytesRead).toString("latin1");
      const lines = (raw + suffix).split("\n");
      for (let index = lines.length - 1; index >= 1; index--) {
        if (index === lines.length - 1 && discardSuffix) continue;
        if (lines[index].length <= 131072) accept(Buffer.from(lines[index], "latin1").toString("utf8"));
      }
      const noBoundary = lines.length === 1;
      discardSuffix = noBoundary && discardSuffix || lines[0].length > 131072;
      suffix = discardSuffix ? "" : lines[0];
    }
    if (position === 0 && !discardSuffix) accept(Buffer.from(suffix, "latin1").toString("utf8"));
    return `Read-only original conversation source: ${file}\nRecent excerpts, oldest first (bounded; not a complete history):\n${JSON.stringify(excerpts.reverse())}\nIf the latest request only says continue, recover its preceding concrete task from this source. Do not treat runtime/workspace instructions as a task.`;
  } finally { await handle.close(); }
}
