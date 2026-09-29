import fs from "node:fs/promises";
import path from "node:path";

export interface AppendedRollbackMarker {
  filePath: string;
  originalSize: number;
  appendedSize: number;
}

/** Append the historical Codex rollback event only while its app-server is stopped. */
export async function appendLegacyRollbackMarker(codexHome: string, filePath: string, threadId: string): Promise<AppendedRollbackMarker> {
  const sessionsRoot = await fs.realpath(path.join(codexHome, "sessions"));
  const resolved = await fs.realpath(filePath);
  if (!resolved.startsWith(`${sessionsRoot}${path.sep}`) || !path.basename(resolved).endsWith(`-${threadId}.jsonl`)) {
    throw new Error("The rollout is not the requested account's thread.");
  }
  const handle = await fs.open(resolved, "r+");
  try {
    const stat = await handle.stat();
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
      payload: { type: "thread_rolled_back", num_turns: 1 }
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
