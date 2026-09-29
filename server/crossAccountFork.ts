import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const headerReadChunkBytes = 64 * 1024;
const maximumHeaderBytes = 4 * 1024 * 1024;

function assertInside(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("分支源会话路径不在所属账号的 sessions 目录中。");
  }
}

async function readFirstLine(file: fsPromises.FileHandle, size: number): Promise<{ value: Buffer; nextOffset: number }> {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < size && offset < maximumHeaderBytes) {
    const chunk = Buffer.alloc(Math.min(headerReadChunkBytes, size - offset, maximumHeaderBytes - offset));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
    if (!bytesRead) break;
    const used = chunk.subarray(0, bytesRead);
    const newline = used.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(used.subarray(0, newline));
      return { value: Buffer.concat(chunks), nextOffset: offset + newline + 1 };
    }
    chunks.push(used);
    offset += bytesRead;
  }
  throw new Error("分支源会话缺少有效的 session_meta 首行。");
}

async function lastCompleteLineEnd(file: fsPromises.FileHandle, size: number): Promise<number> {
  let cursor = size;
  while (cursor > 0) {
    const length = Math.min(headerReadChunkBytes, cursor);
    const start = cursor - length;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await file.read(chunk, 0, length, start);
    if (!bytesRead) break;
    const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newline >= 0) return start + newline + 1;
    cursor = start;
  }
  return 0;
}

/**
 * Codex 0.153.x only allows thread/fork(path=...) across thread stores for a
 * legacy rollout. A paginated rollout still contains the complete append-only
 * JSONL, so expose a private, stable legacy *view* by changing only the copied
 * session metadata. Model-visible response items remain byte-for-byte intact.
 */
export async function createCrossAccountForkSnapshot(
  sourcePath: string,
  sourceSessionsRoot: string
): Promise<{ path: string; remove: () => Promise<void> }> {
  const [realSource, realRoot] = await Promise.all([
    fsPromises.realpath(sourcePath),
    fsPromises.realpath(sourceSessionsRoot)
  ]);
  assertInside(realSource, realRoot);
  const sourceStat = await fsPromises.lstat(realSource);
  if (!sourceStat.isFile()) throw new Error("分支源会话不是普通 JSONL 文件。");

  const source = await fsPromises.open(realSource, "r");
  const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "codex-cross-account-fork-"));
  await fsPromises.chmod(temporaryRoot, 0o700);
  const snapshotPath = path.join(temporaryRoot, "source.jsonl");
  try {
    const capturedSize = (await source.stat()).size;
    const completeEnd = await lastCompleteLineEnd(source, capturedSize);
    const firstLine = await readFirstLine(source, completeEnd);
    const metadata = JSON.parse(firstLine.value.toString("utf8")) as {
      type?: unknown;
      payload?: { history_mode?: unknown };
    };
    if (metadata.type !== "session_meta" || !metadata.payload || typeof metadata.payload !== "object") {
      throw new Error("分支源会话的 session_meta 无效。");
    }
    metadata.payload.history_mode = "legacy";
    await fsPromises.writeFile(snapshotPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });

    if (completeEnd > firstLine.nextOffset) {
      await new Promise<void>((resolve, reject) => {
        const input = fs.createReadStream(realSource, {
          start: firstLine.nextOffset,
          end: completeEnd - 1
        });
        const output = fs.createWriteStream(snapshotPath, { flags: "a", mode: 0o600 });
        input.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);
        input.pipe(output);
      });
    }
    return {
      path: snapshotPath,
      remove: () => fsPromises.rm(temporaryRoot, { recursive: true, force: true })
    };
  } catch (error) {
    await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await source.close();
  }
}
