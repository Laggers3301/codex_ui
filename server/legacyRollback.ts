import fs from "node:fs/promises";
import path from "node:path";

export class LegacyRollbackConflictError extends Error {}

export interface AppendedRollbackMarker {
  filePath: string;
  originalSize: number;
  appendedSize: number;
}

export interface LegacyTurnMetadata {
  id: string;
  status: "running" | "completed" | "failed" | "interrupted";
  hasUserMessage: boolean;
}

export interface LegacyTailMetadata {
  latest: LegacyTurnMetadata | null;
  previous: LegacyTurnMetadata | null;
  size: number;
  mtimeMs: number;
  inode: number;
  bytesRead: number;
  target: LegacyTurnMetadata | null;
  rollbackTurns: number;
  retainedPrevious: LegacyTurnMetadata | null;
}

/** Read backwards with bounded buffers. Tool output and message bodies never
 * become part of the returned metadata (including a single enormous JSON line).
 * Unknown oversized structural records fail closed rather than guessing. */
export async function readLegacyTailMetadata(filePath: string, targetTurnId?: string): Promise<LegacyTailMetadata> {
  const handle = await fs.open(filePath, "r");
  const chunkSize = 64 * 1024, maxRecord = 64 * 1024;
  let bytesRead = 0;
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size < 1) throw new LegacyRollbackConflictError("会话历史文件为空，不能安全撤回。");
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, initial.size - 1);
    if (last[0] !== 10) throw new LegacyRollbackConflictError("会话历史最后一条记录尚未完整写入，请稍后重试。");
    const turns: LegacyTurnMetadata[] = [], seen = new Set<string>();
    let targetIndex = -1;
    const complete = () => targetTurnId ? targetIndex >= 0 && turns.length > targetIndex + 1 : turns.length >= 2;
    const terminals = new Map<string, LegacyTurnMetadata["status"]>();
    const terminal = (id: string, status: LegacyTurnMetadata["status"]) => {
      if (!terminals.has(id) && terminals.size >= 4096) throw new LegacyRollbackConflictError("末轮结束状态校验范围过大，未执行撤回。");
      terminals.set(id, status);
    };
    let skippedTurns = 0, hasUser = false;
    let parts: Buffer[] = [], length = 0, oversized = false;
    const processLine = (line: Buffer, prefix: Buffer) => {
      let record: { type?: string; payload?: Record<string, unknown> };
      if (oversized) {
        // Native rollouts put the structural fields before the large content.
        const text = prefix.toString("utf8");
        const outer = text.match(/(?:^|[,{])\s*"type"\s*:\s*"([^"]+)"/);
        const payload = text.match(/"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"/);
        const type = payload?.[1];
        if (!outer || !type) throw new LegacyRollbackConflictError("末轮记录的元数据无法安全读取，未执行撤回。");
        if (outer[1] === "response_item") {
          if (type === "message") {
            const role = text.match(/(?:^|[,{])\s*"role"\s*:\s*"([^"]+)"/)?.[1];
            if (!role) throw new LegacyRollbackConflictError("超长消息缺少可读取的角色元数据，未执行撤回。");
            if (role === "user") hasUser = true;
          }
          return;
        }
        if (outer[1] === "event_msg" && type === "user_message") { hasUser = true; return; }
        if (outer[1] === "event_msg" && ["agent_message", "agent_reasoning", "token_count"].includes(type)) return;
        if (outer[1] === "event_msg" && ["task_complete", "turn_aborted"].includes(type)) {
          const id = text.match(/(?:^|[,{])\s*"turn_id"\s*:\s*"([^"\\]+)"/)?.[1];
          if (id) { terminal(id, type === "turn_aborted" ? "interrupted" : "completed"); return; }
        }
        throw new LegacyRollbackConflictError("超长结构记录无法安全校验，未执行撤回。");
      }
      if (!line.length) return;
      try { record = JSON.parse(line.toString("utf8")); }
      catch { throw new LegacyRollbackConflictError("会话末尾存在无法解析的记录，未执行撤回。"); }
      if (!record || typeof record !== "object" || Array.isArray(record)) throw new LegacyRollbackConflictError("会话末尾存在无效结构记录，未执行撤回。");
      const p = record.payload ?? {};
      if (record.type === "event_msg" && p.type === "thread_rolled_back") {
        if (!Number.isSafeInteger(p.num_turns) || Number(p.num_turns) < 1) throw new LegacyRollbackConflictError("历史撤回标记不完整，未执行撤回。");
        skippedTurns += Number(p.num_turns);
        if (skippedTurns > 4096) throw new LegacyRollbackConflictError("历史撤回层级过深，未执行撤回。");
      }
      if ((record.type === "response_item" && p.type === "message" && p.role === "user") || (record.type === "event_msg" && p.type === "user_message")) hasUser = true;
      if (record.type === "event_msg" && typeof p.turn_id === "string") {
        if (p.type === "task_complete") terminal(p.turn_id, p.error ? "failed" : "completed");
        if (p.type === "turn_aborted") terminal(p.turn_id, "interrupted");
      }
      if ((record.type === "turn_context" || (record.type === "event_msg" && p.type === "task_started")) && typeof p.turn_id === "string" && !seen.has(p.turn_id)) {
        if (seen.size >= 4096) throw new LegacyRollbackConflictError("末轮校验范围过大，未执行撤回。");
        seen.add(p.turn_id);
        const turn = { id: p.turn_id, status: terminals.get(p.turn_id) ?? "running", hasUserMessage: hasUser };
        hasUser = false;
        if (skippedTurns) skippedTurns--;
        else {
          turns.push(turn);
          if (turn.id === targetTurnId) targetIndex = turns.length - 1;
        }
      }
    };
    let position = initial.size;
    while (position > 0 && !complete()) {
      const start = Math.max(0, position - chunkSize);
      const chunk = Buffer.alloc(position - start);
      const read = await handle.read(chunk, 0, chunk.length, start);
      if (read.bytesRead !== chunk.length) throw new LegacyRollbackConflictError("历史文件在校验过程中发生变化，请刷新后重试。");
      bytesRead += read.bytesRead;
      let end = chunk.length;
      for (let i = chunk.length - 1; i >= 0 && !complete(); i--) {
        if (chunk[i] !== 10) continue;
        const segment = chunk.subarray(i + 1, end);
        length += segment.length;
        if (length > maxRecord) oversized = true;
        processLine(oversized ? Buffer.alloc(0) : Buffer.concat([segment, ...parts], length), segment.length ? segment : parts[0] ?? Buffer.alloc(0));
        parts = []; length = 0; oversized = false;
        end = i;
      }
      if (!complete()) {
        const segment = chunk.subarray(0, end);
        length += segment.length;
        if (length > maxRecord) oversized = true;
        if (!oversized) parts.unshift(segment);
        else parts = [segment]; // Keep only the newest left prefix, not the body.
      }
      position = start;
    }
    if (position === 0 && !complete() && length) processLine(oversized ? Buffer.alloc(0) : Buffer.concat(parts, length), parts[0] ?? Buffer.alloc(0));
    const final = await handle.stat();
    if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ino !== final.ino) throw new LegacyRollbackConflictError("历史文件在校验过程中发生变化，请刷新后重试。");
    const selected = targetTurnId ? targetIndex : 0;
    return { latest: turns[0] ?? null, previous: turns[1] ?? null, target: turns[selected] ?? null,
      rollbackTurns: selected >= 0 && turns[selected] ? selected + 1 : 0,
      retainedPrevious: turns[selected + 1] ?? null,
      size: initial.size, mtimeMs: initial.mtimeMs, inode: initial.ino, bytesRead };
  } finally { await handle.close(); }
}

/** Append the historical Codex rollback event only while its app-server is stopped. */
export async function appendLegacyRollbackMarker(codexHome: string, filePath: string, threadId: string, expected?: Pick<LegacyTailMetadata, "size" | "mtimeMs" | "inode">, numTurns = 1): Promise<AppendedRollbackMarker> {
  if (!Number.isSafeInteger(numTurns) || numTurns < 1 || numTurns > 4096) throw new LegacyRollbackConflictError("撤回轮数无效，原记录未改动。");
  const sessionsRoot = await fs.realpath(path.join(codexHome, "sessions"));
  const resolved = await fs.realpath(filePath);
  if (!resolved.startsWith(`${sessionsRoot}${path.sep}`) || !path.basename(resolved).endsWith(`-${threadId}.jsonl`)) {
    throw new Error("The rollout is not the requested account's thread.");
  }
  const handle = await fs.open(resolved, "r+");
  try {
    const stat = await handle.stat();
    if (expected && (stat.size !== expected.size || stat.mtimeMs !== expected.mtimeMs || stat.ino !== expected.inode)) throw new LegacyRollbackConflictError("校验后的历史文件发生变化，未执行撤回，请刷新后重试。");
    if (!stat.isFile() || stat.size <= 0) throw new Error("The legacy rollout is empty.");
    const headerChunks: Buffer[] = [];
    let offset = 0;
    let headerEnd = -1;
    while (offset < Math.min(stat.size, 8 * 1024 * 1024) && headerEnd < 0) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      headerEnd = chunk.indexOf(10, 0);
      headerChunks.push(headerEnd < 0 ? chunk.subarray(0, bytesRead) : chunk.subarray(0, headerEnd));
      offset += bytesRead;
    }
    if (headerEnd < 0) throw new Error("The rollout header is incomplete or too large.");
    const header = JSON.parse(Buffer.concat(headerChunks).toString("utf8")) as { type?: string; payload?: { id?: string; history_mode?: string } };
    if (header.type !== "session_meta" || header.payload?.id !== threadId || header.payload.history_mode !== "legacy") {
      throw new Error("The rollout does not match the requested legacy thread.");
    }
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, stat.size - 1);
    if (last[0] !== 10) throw new Error("The rollout has an incomplete final record.");
    const marker = Buffer.from(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "thread_rolled_back", num_turns: numTurns }
    })}\n`);
    try {
      const { bytesWritten } = await handle.write(marker, 0, marker.length, stat.size);
      if (bytesWritten !== marker.length) throw new Error("The rollback marker was only partially written.");
      await handle.sync();
    } catch (error) {
      const current = await handle.stat();
      if (current.size <= stat.size + marker.length) {
        await handle.truncate(stat.size);
        await handle.sync();
      }
      throw error;
    }
    return { filePath: resolved, originalSize: stat.size, appendedSize: marker.length };
  } finally {
    await handle.close();
  }
}

/** Undo our own marker only if nothing else has written the file meanwhile. */
export async function removeAppendedRollbackMarker(marker: AppendedRollbackMarker): Promise<void> {
  const handle = await fs.open(marker.filePath, "r+");
  try {
    const stat = await handle.stat();
    if (stat.size !== marker.originalSize + marker.appendedSize) {
      throw new Error("The rollout changed after rollback; refusing to truncate another writer's data.");
    }
    await handle.truncate(marker.originalSize);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
