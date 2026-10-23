import path from 'node:path';
import fs from 'node:fs/promises';
import type { CodexBridge } from './codexBridge.js';
import { isAccountPoolBridge } from './accountPoolBridge.js';
import type { ProjectStore } from './db.js';
import { findThreadJsonlPathById, threadJsonlSessionsRoot } from './threadFallback.js';
import { rolloutLogicalStat } from './rolloutStorage.js';
import { assertLargeBranchMemory, branchGate, BranchConflictError, copyLargeThreadBranch, isLegacyRollout, largeThreadForkBytes } from './largeThreadFork.js';
import { toolArchivePath, toolArchiveRoot } from './toolOutputArchive.js';
import { serverConfig } from './config.js';

/** Same-account context inheritance, never an unguarded bulk native fork. */
export async function forkSideChatContext(bridge: CodexBridge, store: ProjectStore, userId: string, projectId: string,
  parentThreadId: string, params: Record<string, unknown>, reasoningEffort: string) {
  const release = branchGate.enter();
  try {
    const pool = isAccountPoolBridge(bridge) ? bridge : null;
    const account = pool ? await pool.resolveThreadAccount(parentThreadId) : null;
    if (pool && !pool.canThreadUseModel(parentThreadId, String(params.model))) {
      throw new BranchConflictError('所选模型不属于主会话供应商。请先在主会话创建跨供应商分支，再使用侧边提问。');
    }
    let sourcePath = await findThreadJsonlPathById(parentThreadId);
    if (!sourcePath && pool) {
      const metadata = await bridge.request('thread/read', {threadId: parentThreadId, includeTurns: false}, 10_000) as {thread?: {path?: string; rolloutPath?: string}};
      sourcePath = metadata.thread?.path ?? metadata.thread?.rolloutPath ?? null;
      if (!sourcePath) throw new BranchConflictError('无法确认主会话历史大小，已停止创建侧边分支，请稍后重试。');
    }
    const size = sourcePath ? (await rolloutLogicalStat(sourcePath)).size : 0;
    const large = size >= largeThreadForkBytes;
    if (large && sourcePath && await isLegacyRollout(sourcePath)) {
      if (!pool || !account) throw new BranchConflictError('当前运行时不能安全复制大会话，请使用主会话分支入口。');
      const routing = pool.getBranchRoutingDecision(parentThreadId, String(params.model), account.id);
      const sourceRoot = threadJsonlSessionsRoot(sourcePath);
      if (!sourceRoot) throw new BranchConflictError('无法确认大会话的所属历史目录，原会话未修改。');
      assertLargeBranchMemory(64 * 1024 * 1024);
      const archiveRoot = toolArchiveRoot(serverConfig.dataDir, userId);
      const copied = await copyLargeThreadBranch({ sourcePath, sourceSessionsRoot: sourceRoot,
        sourceThreadId: parentThreadId, targetSessionsRoot: path.join(routing.targetAccount.codexHome, 'sessions'),
        cwd: String(params.cwd), toolArchiveRoot: archiveRoot });
      try {
        assertLargeBranchMemory(copied.copiedBytes);
        const headroom = pool.getAccountMemoryHeadroom(account.id);
        if (headroom !== null) assertLargeBranchMemory(copied.copiedBytes, headroom);
      } catch (error) {
        await Promise.all([copied.path, toolArchivePath(archiveRoot, copied.threadId), toolArchivePath(archiveRoot, copied.threadId) + '.json']
          .map(file => fs.unlink(file).catch(() => undefined)));
        throw error;
      }
      pool.assignThreadsToAccount([copied.threadId], account.id);
      store.registerThreadOwner({ threadId: copied.threadId, userId, projectId, rootPath: String(params.cwd),
        model: String(params.model), reasoningEffort: reasoningEffort as Parameters<ProjectStore['registerThreadOwner']>[0]['reasoningEffort'] });
      try {
        return await bridge.request('thread/resume', { ...params, threadId: copied.threadId, path: copied.path,
          excludeTurns: true, deferGoalContinuation: true }, 60_000);
      } catch (error) {
        store.softDeleteThread(copied.threadId, userId, projectId);
        throw error;
      }
    }
    // Unknown/non-legacy large formats are never rewritten; budget them first.
    if (size > 0) {
      assertLargeBranchMemory(size);
      const headroom = account && pool ? pool.getAccountMemoryHeadroom(account.id) : null;
      if (headroom !== null) assertLargeBranchMemory(size, headroom);
    }
    return await bridge.request('thread/fork', { ...params, threadId: parentThreadId, excludeTurns: true, deferGoalContinuation: true }, 60_000);
  } finally { release(); }
}
