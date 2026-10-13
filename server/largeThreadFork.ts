import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {archivedOutputPreview,createToolOutputArchive,type ToolArchiveSummary} from "./toolOutputArchive.js";

export const largeThreadForkBytes = 128 * 1024 * 1024;
const maxRecordBytes = 64 * 1024 * 1024;
type Row = { type?: string; timestamp?: string; payload?: Record<string, unknown> };

export class BranchConflictError extends Error {
  readonly statusCode = 409;
}

/** No concurrent bulk history hydrations, including requests from different tabs/users. */
export class BranchGate {
  private busy = false;
  enter(): () => void {
    if (this.busy) throw new BranchConflictError("已有分支正在创建，请等待完成后再试；原会话不会改变。");
    this.busy = true;
    let released = false;
    return () => { if (!released) { released = true; this.busy = false; } };
  }
}

/** Byte offsets, not decoded string lengths; bounded by one record, never the rollout. */
async function* records(file: fsp.FileHandle, size: number) {
  let chunks: Buffer[] = [];
  let length = 0;
  let start = 0;
  for await (const chunk of file.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
    const value = chunk as Buffer;
    let cursor = 0;
    while (cursor < value.length) {
      const newline = value.indexOf(10, cursor);
      const end = newline < 0 ? value.length : newline + 1;
      chunks.push(value.subarray(cursor, end));
      length += end - cursor;
      if (length > maxRecordBytes) throw new BranchConflictError("会话中有超大的单条记录，已安全停止分支；原会话未修改。");
      if (newline >= 0) {
        const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
        yield { bytes, start, end: start + length };
        start += length;
        chunks = [];
        length = 0;
      }
      cursor = end;
    }
  }
  // A concurrently appended incomplete JSONL record is never copied.
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export interface LegacyForkCopy {
  threadId: string;
  path: string;
  copiedBytes: number;
  sourceEnd: number;
  toolArchive?:ToolArchiveSummary;
}

export async function isLegacyRollout(filePath: string): Promise<boolean> {
  const file = await fsp.open(filePath, "r");
  try {
    const size = Math.min((await file.stat()).size, 4 * 1024 * 1024);
    if (!size) return false;
    for await (const record of records(file, size)) {
      const metadata = JSON.parse(record.bytes.toString("utf8")) as Row;
      return metadata.type === "session_meta"
        && (metadata.payload?.history_mode === "legacy" || metadata.payload?.history_mode === undefined);
    }
    throw new BranchConflictError("会话元信息过大或不完整，无法安全判定分支格式。");
  } finally { await file.close(); }
}

/**
 * Legacy native fork builds a second complete UI history, even with excludeTurns.
 * Stream the exact terminal prefix into a new identity instead, then let native
 * thread/resume rebuild its model context (including the original compactions).
 * No summaries, prompts, tool outputs or prior timestamps are reconstructed.
 */
export async function copyLargeThreadBranch(options: {
  sourcePath: string;
  sourceSessionsRoot: string;
  sourceThreadId: string;
  lastTurnId: string;
  targetSessionsRoot: string;
  cwd: string;
  toolArchiveRoot?: string;
}): Promise<LegacyForkCopy> {
  const sourcePath = await fsp.realpath(options.sourcePath);
  const sourceRoot = await fsp.realpath(options.sourceSessionsRoot);
  if (!inside(sourcePath, sourceRoot)) throw new BranchConflictError("分支源会话不在所属账号的 sessions 目录中。");
  const file = await fsp.open(sourcePath, "r");
  let stagedPath: string | null = null;
  let archive: Awaited<ReturnType<typeof createToolOutputArchive>> | null = null;
  let archiveComplete=false;
  let createdPath:string|null=null;
  let branchComplete=false;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size <= 0) throw new BranchConflictError("分支源会话不是有效文件。");
    let metadata: Row | null = null;
    let headerEnd = 0;
    let completeEnd = 0;
    let targetStart: number | null = null;
    let targetEnd: number | null = null;
    let current: { id: string; terminal: boolean } | null = null;
    const turns: Array<{ id: string; terminal: boolean }> = [];
    for await (const record of records(file, before.size)) {
      completeEnd = record.end;
      if (!metadata) {
        metadata = JSON.parse(record.bytes.toString("utf8")) as Row;
        if (metadata.type !== "session_meta" || metadata.payload?.id !== options.sourceThreadId) {
          throw new BranchConflictError("分支源会话标识不匹配，已停止操作。");
        }
        if (metadata.payload.history_mode !== undefined && metadata.payload.history_mode !== "legacy") {
          throw new BranchConflictError("分页历史应由原生分支接口处理，不能使用旧格式兼容复制。");
        }
        headerEnd = record.end;
        continue;
      }
      // Lifecycle records are small. Avoid decoding megabytes of image/tool data
      // just to find their boundaries. If a lifecycle row is large, parse it too.
      const prefix = record.bytes.subarray(0, 512).toString("utf8");
      if (!/"type"\s*:\s*"event_msg"/.test(prefix)
          || !/"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|thread_rolled_back)"/.test(prefix)) continue;
      const row = JSON.parse(record.bytes.toString("utf8")) as Row;
      if (row.type !== "event_msg") continue;
      const payload = row.payload ?? {};
      if (payload.type === "task_started" && typeof payload.turn_id === "string") {
        if (targetStart !== null && targetEnd === null) targetEnd = record.start;
        if (payload.turn_id === options.lastTurnId) {
          if (targetStart !== null) throw new BranchConflictError("该回答有重复的轮次边界，无法安全创建分支。");
          targetStart = record.start;
        }
        current = { id: payload.turn_id, terminal: false };
        turns.push(current);
      } else if (payload.type === "task_complete" || payload.type === "turn_aborted") {
        const id = typeof payload.turn_id === "string" ? payload.turn_id : current?.id;
        const turn = [...turns].reverse().find((candidate) => candidate.id === id);
        if (turn) turn.terminal = true;
      } else if (payload.type === "thread_rolled_back") {
        const count = payload.num_turns;
        if (!Number.isSafeInteger(count) || Number(count) < 0) throw new BranchConflictError("会话撤回标记无效，无法安全创建分支。");
        turns.splice(Math.max(0, turns.length - Number(count)));
        current = null;
      }
    }
    const target = turns.find((turn) => turn.id === options.lastTurnId);
    if (!metadata || targetStart === null || !target) throw new BranchConflictError("所选回答不存在或已经撤回，请刷新会话后重试。");
    if (!target.terminal) throw new BranchConflictError("所选回答还未结束，请先停止或等待完成后再创建分支。");
    const sourceEnd = targetEnd ?? completeEnd;
    const after = await file.stat();
    if (after.size < before.size || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) {
      throw new BranchConflictError("会话记录刚刚发生变更，请重试分支。");
    }
    const now = new Date();
    const threadId = randomUUID();
    const payload = { ...metadata.payload, id: threadId, session_id: threadId,
      forked_from_id: options.sourceThreadId, timestamp: now.toISOString(),
      cwd: options.cwd, runtime_workspace_roots: [options.cwd],
      source: "cli", thread_source: "user", history_mode: "legacy" };
    // A user-created branch is a root conversation, not a live child actor.
    for (const key of ["agent_path", "agent_nickname", "agent_role", "agent_name"]) delete (payload as Record<string, unknown>)[key];
    const targetRoot = path.resolve(options.targetSessionsRoot);
    await fsp.mkdir(targetRoot, { recursive: true, mode: 0o700 });
    const realTargetRoot = await fsp.realpath(targetRoot);
    const directory = path.join(realTargetRoot, now.toISOString().slice(0, 10).replaceAll("-", path.sep));
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    if (!inside(await fsp.realpath(directory), realTargetRoot)) throw new BranchConflictError("目标会话目录不在所属账号内。");
    const destination = path.join(directory, `rollout-${now.toISOString().slice(0, 19).replaceAll(":", "-")}-${threadId}.jsonl`);
    stagedPath = `${destination}.partial`;
    const header = Buffer.from(`${JSON.stringify({ ...metadata, timestamp: now.toISOString(), payload })}\n`);
    await fsp.writeFile(stagedPath, header, { mode: 0o600, flag: "wx" });
    let archiveSummary:ToolArchiveSummary|undefined;
    if(options.toolArchiveRoot){
      const targetIndex=turns.findIndex(t=>t.id===options.lastTurnId);
      const recentIds=turns.slice(0,targetIndex+1).slice(-2).map(t=>t.id);
      const recent=new Set(recentIds);
      archive=await createToolOutputArchive(options.toolArchiveRoot,{version:1,threadId,sourceThreadId:options.sourceThreadId,keptRecentTurnIds:recentIds,archivedRecords:0,archivedBytes:0,originalBranchBytes:header.length+sourceEnd-headerEnd,branchBytes:0,archiveBytes:0,createdAt:now.toISOString()});
      const destinationHandle=await fsp.open(stagedPath,"a");
      let currentTurn:string|undefined;
      try{
        for await(const record of records(file,sourceEnd)){
          if(record.start<headerEnd)continue;
          const prefix=record.bytes.subarray(0,512).toString("utf8");
          if(/"type"\s*:\s*"event_msg"/.test(prefix)){
            const row=JSON.parse(record.bytes.toString("utf8")) as Row;
            if(row.payload?.type==="task_started"&&typeof row.payload.turn_id==="string")currentTurn=row.payload.turn_id;
          }
          let transformed:Record<string,any>|null=null;
          if(/"type"\s*:\s*"response_item"/.test(prefix)&&/(custom_tool_call_output|function_call_output)/.test(prefix)){
            const row=JSON.parse(record.bytes.toString("utf8"));
            const turnId=row.payload?.internal_chat_message_metadata_passthrough?.turn_id??currentTurn;
            // Missing turn attribution is unsafe: preserve rather than guess.
            if(typeof turnId==="string"&&!recent.has(turnId))transformed=archivedOutputPreview(row,archive.path);
          }
          if(transformed){await archive.append(record.bytes,record.start);await destinationHandle.writeFile(`${JSON.stringify(transformed)}\n`);}
          else await destinationHandle.writeFile(record.bytes);
        }
        await destinationHandle.sync();
      }finally{await destinationHandle.close();}
    }else await pipeline(file.createReadStream({ start: headerEnd, end: sourceEnd - 1, autoClose: false }), fs.createWriteStream(stagedPath, { flags: "a", mode: 0o600 }));
    const copied = await fsp.open(stagedPath, "r+");
    try { await copied.sync(); } finally { await copied.close(); }
    const currentSource = await fsp.stat(sourcePath);
    if (currentSource.ino !== before.ino || currentSource.size < before.size
        || (currentSource.size === before.size && currentSource.mtimeMs !== before.mtimeMs)) {
      throw new BranchConflictError("复制时原会话发生变更，已停止分支；请重试。");
    }
    await fsp.rename(stagedPath, destination);
    createdPath=destination;
    stagedPath = null;
    if(archive){
      archiveSummary=await archive.finish((await fsp.stat(destination)).size);
      archiveComplete=true;
    }
    branchComplete=true;
    return { threadId, path: destination, copiedBytes: (await fsp.stat(destination)).size, sourceEnd, ...(archiveSummary?{toolArchive:archiveSummary}:{}) };
  } finally {
    await file.close();
    if (stagedPath) await fsp.unlink(stagedPath).catch(() => {});
    if(archive&&!archiveComplete)await archive.abort();
    if(createdPath&&!branchComplete)await fsp.unlink(createdPath).catch(()=>{});
  }
}

export function assertLargeBranchMemory(sourceBytes: number, availableBytes?: number): void {
  let available = availableBytes;
  if (available === undefined) {
    try {
      const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
      available = Number(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024;
    } catch { available = os.freemem(); }
  }
  // Measured native resume needs ~2.4x this legacy rollout. Keep headroom for
  // the shared running conversations rather than raising their resource cap.
  if (!Number.isFinite(available) || available! < sourceBytes * 3 + 512 * 1024 * 1024) {
    throw new BranchConflictError("当前可用内存不足以安全加载这个大历史分支，请稍后重试；不会中断其他会话。");
  }
}
