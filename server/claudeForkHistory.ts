import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { finished, pipeline } from "node:stream/promises";
import { AppError } from "./appErrors.js";
import type { ToolArchiveSummary } from "./toolOutputArchive.js";

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_RECORD = 32 * 1024 * 1024;
const IMPORT_RESULT = "[历史工具结果，仅供参考]\n";
type Row = Record<string, any>;
export interface ClaudeToolArchive {
  path: string;
  summary: ToolArchiveSummary;
  imported?: { timestamp: string };
}
interface Options {
  threadId: string;
  directory: string;
  imported?: { timestamp: string };
  previous?: ClaudeToolArchive;
  upToMessageId?: string;
  /** May lower the limit for bounded fixtures; never raises the live limit. */
  targetBytes?: number;
}
async function* records(file: string): AsyncGenerator<{ bytes: Buffer; index: number; offset: number }> {
  let parts: Buffer[] = [], size = 0, index = 0, offset = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start), part = chunk.subarray(start, end < 0 ? chunk.length : end + 1);
      size += part.length;
      if (size > MAX_RECORD) throw new AppError("claude_history_too_large", "单条原生历史超出安全处理上限，完整原文已保留，未切换会话。");
      parts.push(part);
      if (end < 0) break;
      const bytes = Buffer.concat(parts, size);
      yield { bytes, index: index++, offset };
      offset += size; parts = []; size = 0; start = end + 1;
      if (start === chunk.length) break;
    }
  }
  if (size) yield { bytes: Buffer.concat(parts, size), index, offset };
}
function parse(bytes: Buffer): Row | null { try { const row = JSON.parse(bytes.toString("utf8")); return row && typeof row === "object" ? row : null; } catch { return null; } }
function importedResult(row: Row, imported?: Options["imported"]): boolean {
  const content = row.message?.content;
  return !!imported && row.timestamp === imported.timestamp && row.type === "user" && row.message?.role === "user"
    && Array.isArray(content) && content.length === 1 && content[0]?.type === "text"
    && typeof content[0].text === "string" && content[0].text.startsWith(IMPORT_RESULT);
}
function startsTurn(row: Row, imported?: Options["imported"]): boolean {
  if (row.type !== "user" || row.isMeta || row.isSidechain || row.message?.role !== "user" || importedResult(row, imported)) return false;
  const content = row.message.content;
  return typeof content === "string" || (Array.isArray(content) && content.some((block: Row) => block?.type !== "tool_result"));
}
function excerpt(text: string, budget: number): string {
  const bytes = Buffer.from(text);
  return bytes.subarray(0, Math.floor(budget * .6)).toString("utf8") + "\n[…完整工具结果已归档…]\n" + bytes.subarray(-Math.floor(budget * .4)).toString("utf8");
}
function compact(row: Row, options: Options, threshold: number, budget: number, archivePath: string): Row | null {
  const notice = `[较早的工具结果已归档；完整记录：${archivePath}，message_uuid=${String(row.uuid ?? "未知")}。]\n`;
  const trim = (text: unknown): unknown => typeof text === "string" && Buffer.byteLength(text) > threshold ? notice + excerpt(text, budget) : text;
  if (importedResult(row, options.imported)) {
    const original = row.message.content[0].text, text = trim(original);
    return text !== original ? { ...row, message: { ...row.message, content: [{ ...row.message.content[0], text }] } } : null;
  }
  if (row.type !== "user" || row.message?.role !== "user" || !Array.isArray(row.message.content)) return null;
  let changed = false, toolResult = false;
  const content = row.message.content.map((block: Row) => {
    if (block?.type !== "tool_result") return block;
    toolResult = true;
    if (typeof block.content === "string") {
      const value = trim(block.content); if (value === block.content) return block;
      changed = true; return { ...block, content: value };
    }
    if (!Array.isArray(block.content)) return block;
    const parts = block.content.map((part: Row) => {
      if (part?.type !== "text") return part; // Preserve images, opaque/encrypted and unknown blocks.
      const text = trim(part.text); if (text === part.text) return part;
      changed = true; return { ...part, text };
    });
    return { ...block, content: parts };
  });
  let toolUseResult = row.toolUseResult;
  if (toolResult && toolUseResult && typeof toolUseResult === "object" && !Array.isArray(toolUseResult)) {
    toolUseResult = { ...toolUseResult };
    for (const key of ["stdout", "stderr", "text"]) {
      const value = trim(toolUseResult[key]);
      if (value !== toolUseResult[key]) { changed = true; toolUseResult[key] = value; }
    }
  }
  return changed ? { ...row, message: { ...row.message, content }, ...(row.toolUseResult !== undefined ? { toolUseResult } : {}) } : null;
}
async function concatenate(files: string[], destination: string) {
  const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
  const complete = finished(output); void complete.catch(() => {});
  try {
    for (const file of files) for await (const chunk of fs.createReadStream(file)) if (!output.write(chunk)) await once(output, "drain");
    output.end(); await complete;
  } catch (error) { output.destroy(); await complete.catch(() => {}); throw error; }
}

/** Only rewrites a private fork-staging copy. Native originals, user/assistant
 * prose, unknown records and the last two complete turns remain untouched. */
export async function prepareClaudeForkHistory(file: string, options: Options): Promise<ClaudeToolArchive | undefined> {
  const limit = options.targetBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BYTES) throw new Error("Invalid native history budget");
  const before = await fsp.stat(file);
  if (before.size <= limit) return options.previous;
  let recent: Array<{ index: number; uuid: string }> = [];
  let pastCutoff = false;
  for await (const record of records(file)) {
    const row = parse(record.bytes);
    if (!pastCutoff && row && startsTurn(row, options.imported)) recent = [...recent, { index: record.index, uuid: String(row.uuid ?? "") }].slice(-2);
    if (options.upToMessageId && row?.uuid === options.upToMessageId) pastCutoff = true;
  }
  if (options.upToMessageId && !pastCutoff) throw new Error("Native fork cutoff is not present in history");
  const cutoff = recent.length === 2 ? recent[0].index : 0;
  await fsp.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const archive = path.join(options.directory, "tool-results.jsonl.gz");
  if (options.previous && path.resolve(options.previous.path) === path.resolve(archive)) throw new Error("A published archive cannot be reused as a preparation destination");
  const policies = [[8192, 2048], [1024, 256], [512, 128]];
  // A preparation crash precedes the SDK invocation. Its private partials may
  // be discarded; previous published archives are in a different operation.
  await Promise.all([archive,...policies.flatMap((_,i)=>[file+`.compact-${i}`,path.join(options.directory,`tool-results-${i}.partial.gz`)])].map(file=>fsp.unlink(file).catch(error=>{if(error.code!=="ENOENT")throw error;})));
  for (let attempt = 0; attempt < policies.length; attempt++) {
    const [threshold, budget] = policies[attempt], temporary = file + `.compact-${attempt}`;
    const partialArchive = path.join(options.directory, `tool-results-${attempt}.partial.gz`);
    const output = await fsp.open(temporary, "wx", 0o600);
    const gzip = createGzip({ level: 1 }), stream = fs.createWriteStream(partialArchive, { flags: "wx", mode: 0o600 });
    const complete = pipeline(gzip, stream); void complete.catch(() => {});
    const zip = async (bytes: string | Buffer) => { if (!gzip.write(bytes)) await once(gzip, "drain"); };
    let archivedRecords = 0, archivedBytes = 0, written = 0;
    try {
      await zip(JSON.stringify({ type: "archive_meta", payload: { version: 1, format: "claude-jsonl", threadId: options.threadId, keptRecentTurnIds: recent.map(row => row.uuid), thresholdBytes: threshold, createdAt: new Date().toISOString() } }) + "\n");
      for await (const record of records(file)) {
        const row = record.index < cutoff ? parse(record.bytes) : null;
        let replacement = row ? compact(row, options, threshold, budget, archive) : null;
        if (replacement && Buffer.byteLength(JSON.stringify(replacement))+1>=record.bytes.length) replacement=null;
        const bytes = replacement ? Buffer.from(JSON.stringify(replacement) + "\n") : record.bytes;
        await output.writeFile(bytes); written += bytes.length;
        if (replacement) {
          await zip(JSON.stringify({ type: "archive_index", sourceByteOffset: record.offset, messageUuid: row!.uuid }) + "\n");
          await zip(record.bytes); if (record.bytes.at(-1) !== 10) await zip("\n");
          archivedRecords++; archivedBytes += record.bytes.length;
        }
      }
      await output.sync(); await output.close(); gzip.end(); await complete;
      if (written > limit || !archivedRecords) { await fsp.unlink(temporary); await fsp.unlink(partialArchive); continue; }
      const after = await fsp.stat(file);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new AppError("claude_history_busy", "原生历史在归档时发生变化，未切换会话。");
      await concatenate([...(options.previous ? [options.previous.path] : []), partialArchive], archive);
      await fsp.rename(temporary, file); await fsp.unlink(partialArchive);
      const prior = options.previous?.summary;
      return { path: archive, ...(options.imported ? { imported: options.imported } : {}), summary: {
        version: 1, threadId: options.threadId, sourceThreadId: options.threadId, keptRecentTurnIds: recent.map(row => row.uuid),
        archivedRecords: archivedRecords + (prior?.archivedRecords ?? 0), archivedBytes: archivedBytes + (prior?.archivedBytes ?? 0),
        originalBranchBytes: before.size, branchBytes: written, archiveBytes: (await fsp.stat(archive)).size, createdAt: new Date().toISOString()
      } };
    } catch (error) {
      await output.close().catch(() => {}); gzip.destroy(); stream.destroy(); await complete.catch(() => {});
      await Promise.all([temporary, partialArchive, archive].map(file => fsp.unlink(file).catch(() => {}))); throw error;
    }
  }
  throw new AppError("claude_history_too_large", "仅归档较早工具结果后仍超出安全分支上限；用户正文、最近两轮及完整原文均已保留，未切换会话。");
}
