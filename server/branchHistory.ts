import { createHash } from 'node:crypto';
import { openReadableRollout, rolloutLogicalStat } from './rolloutStorage.js';
import { findThreadJsonlPathById, readThreadSummaryFromJsonl } from './threadFallback.js';
import { readIndexedThreadItem, readIndexedThreadPage } from './threadEventIndex.js';

type Options = { cursor?: string; before?: number; limit: number; backgroundRefresh?: boolean; maxEndOffset?: number; indexThreadId?: string };
const prefix = 'branch-v1:';
const olderSourceIndexId = (file:string,id:string) => `${id}:source:${createHash('sha256').update(file).digest('hex').slice(0,16)}`;
type BranchCursor = { segment: 'child' | 'parent'; cursor?: string };
function encode(value: BranchCursor): string { return prefix + Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(cursor?: string): BranchCursor | undefined {
  if (!cursor?.startsWith(prefix)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8'));
    if ((value.segment !== 'child' && value.segment !== 'parent') || (value.cursor !== undefined && typeof value.cursor !== 'string')) throw Error();
    return value;
  } catch { throw new Error('Invalid branch history cursor'); }
}
async function parentReference(file: string): Promise<{id:string;end:number}|null> {
  const handle = await openReadableRollout(file);
  try {
    const buffer = Buffer.alloc(1024 * 1024), {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(10, 0); if (newline < 0 || newline >= bytesRead) throw Error('Session metadata exceeds safe preview size');
    const row = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
    const base = row?.payload?.history_base;
    if (!base) return null;
    if (row.type !== 'session_meta' || row.payload.history_mode !== 'paginated' || typeof base.thread_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(base.thread_id) || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 0) throw Error('Invalid branch history reference');
    return { id: base.thread_id, end: base.end_byte_offset };
  } finally { await handle.close(); }
}

/** Read one bounded page, traversing native inherited histories without copying
 * or hydrating them. Parent access must be authorized independently. */
export async function readBranchHistoryPage(file: string, id: string, options: Options, canRead: (parentId:string)=>boolean, ancestry: string[] = []): Promise<any> {
  if (ancestry.length >= 16 || ancestry.includes(`${id}:${file}`)) throw Error('Branch history ancestry is cyclic or too deep');
  const reference = await parentReference(file);
  if (!reference) return readIndexedThreadPage(file, options.indexThreadId ?? id, options);
  if (!canRead(reference.id)) throw Error('无权读取此分支的来源会话');
  const parentFile = await findThreadJsonlPathById(reference.id, undefined, reference.id === id ? {beforeFile:file} : {});
  if (!parentFile) throw Error('分支来源历史暂不可用，原始记录未修改');
  if ((await rolloutLogicalStat(parentFile)).size < reference.end) throw Error('分支来源历史不完整，原始记录未修改');
  const branchCursor = decode(options.cursor);
  const local = await readIndexedThreadPage(file, options.indexThreadId ?? id, { ...options, cursor: branchCursor?.segment === 'child' ? branchCursor.cursor : undefined, before: branchCursor ? 0 : options.before });
  const parentNeeded = branchCursor?.segment === 'parent' || (!branchCursor && (options.before ?? 0) >= local.history.totalItems) || (!branchCursor && local.history.totalItems === 0);
  if (parentNeeded) {
    const parent = await readBranchHistoryPage(parentFile, reference.id, {
      limit: options.limit, maxEndOffset: reference.end, backgroundRefresh: options.backgroundRefresh,
      indexThreadId: reference.id === id ? olderSourceIndexId(parentFile,reference.id) : undefined,
      cursor: branchCursor?.segment === 'parent' ? branchCursor.cursor : undefined,
      before: branchCursor ? 0 : Math.max(0, (options.before ?? 0) - local.history.totalItems)
    }, canRead, [...ancestry,`${id}:${file}`]);
    const summary = await readThreadSummaryFromJsonl(file, id);
    return { thread: { ...summary, turns: parent.thread.turns ?? [] }, history: {
      ...parent.history, totalItems: parent.history.totalItems + local.history.totalItems,
      before: parent.history.before + local.history.totalItems,
      nextBefore: parent.history.nextBefore + local.history.totalItems,
      nextCursor: parent.history.hasOlder ? encode({segment:'parent',cursor:parent.history.nextCursor ?? undefined}) : null
    }};
  }
  if (local.history.hasOlder) return { ...local, history: { ...local.history, nextCursor: encode({segment:'child',cursor:local.history.nextCursor ?? undefined}) } };
  return { ...local, history: { ...local.history, hasOlder:true, nextCursor:encode({segment:'parent'}) } };
}

export async function readBranchHistoryItem(file:string,id:string,itemId:string,canRead:(parentId:string)=>boolean,maxEndOffset?:number,ancestry:string[]=[],indexThreadId=id):Promise<Record<string,unknown>|null> {
  if (ancestry.length >= 16 || ancestry.includes(`${id}:${file}`)) throw Error('Branch history ancestry is cyclic or too deep');
  const own = await readIndexedThreadItem(file,indexThreadId,itemId,{maxEndOffset});
  if (own) return own;
  const reference=await parentReference(file);
  if (!reference) return null;
  if (!canRead(reference.id)) throw Error('无权读取此分支的来源会话');
  const parentFile=await findThreadJsonlPathById(reference.id,undefined,reference.id===id?{beforeFile:file}:{});
  if (!parentFile || (await rolloutLogicalStat(parentFile)).size < reference.end) throw Error('分支来源历史暂不可用，原始记录未修改');
  return readBranchHistoryItem(parentFile,reference.id,itemId,canRead,reference.end,[...ancestry,`${id}:${file}`],reference.id===id?olderSourceIndexId(parentFile,reference.id):reference.id);
}
