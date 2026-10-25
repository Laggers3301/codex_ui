import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HISTORY_LIMIT = 128 * 1024 * 1024;
const blocked = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
export function subagentMemoryHeadroom(read = file => fs.readFileSync(file, 'utf8')) {
  const relative = read('/proc/self/cgroup').split('\n').find(line => line.startsWith('0::'))?.slice(3);
  if (!relative || !/^\/user\.slice\/user-\d+\.slice\/user@\d+\.service\/codex\.slice\/codex-workers\.slice\/codex-agent-[A-Za-z0-9-]+\.scope$/.test(relative)) return null;
  const directory = `/sys/fs/cgroup${relative}`, budgets = [];
  for (const group of [directory, path.dirname(directory)]) {
    const current = Number(read(`${group}/memory.current`).trim());
    // Existing work is never paused at memory.high. Only *new* child admission
    // uses the aggregate planning watermark to avoid entering reclaim thrash.
    for (const name of group === directory ? ['memory.max'] : ['memory.max', 'memory.high']) {
      const raw = read(`${group}/${name}`).trim();
      if (raw !== 'max' && Number.isFinite(Number(raw))) budgets.push(Math.max(0, Number(raw) - current));
    }
  }
  return budgets.length ? Math.min(...budgets) : null;
}
export function evaluateSubagentHistory(input, { home = process.env.CODEX_HOME, limit = HISTORY_LIMIT, stat = fs.statSync, realpath = fs.realpathSync, headroom } = {}) {
  if (input?.hook_event_name !== 'PreToolUse' || !/^(spawn_agent|Agent|collaboration[.]?spawn_agent)$/.test(input?.tool_name ?? '')) return {};
  const args = input.tool_input;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return blocked('无法确认子代理参数，未创建子代理。请使用显式 fork_turns="none" 的自包含任务。');
  // No-history delegation never parses or clones the parent's rollout.
  // Do not treat an unknown legacy field as a v2 no-history instruction: v2
  // can ignore fork_context=false and still use its default complete fork.
  const memoryAllows = historyBytes => {
    try {
      const available = headroom === undefined ? subagentMemoryHeadroom() : headroom;
      const required = 512 * 1024 * 1024 + Math.ceil(historyBytes * 3.5);
      return available === null || available >= required ? {} : blocked('subagent_memory_budget: 账号或共享资源组剩余预算不足，未创建新的子代理。主会话与已有任务未停止；请减少并行数量，待已有代理完成后再试。不要循环重试或重启号池。');
    } catch { return blocked('subagent_memory_unverified: 无法核实资源预算，未创建子代理；请先排查资源状态。主会话未停止。'); }
  };
  if (args.fork_turns === 'none' && args.fork_context !== true) return memoryAllows(0);
  try {
    if (!home || typeof input.transcript_path !== 'string') throw Error('unknown');
    const root = realpath(home), file = realpath(input.transcript_path);
    if (!file.startsWith(`${root}${path.sep}`) || !/\.jsonl$/.test(file)) throw Error('unknown');
    const metadata = stat(file);
    if (!metadata.isFile()) throw Error('unknown');
    const budget = Math.min(HISTORY_LIMIT, Math.max(1, limit));
    if (metadata.size >= budget) return blocked(`subagent_history_budget: 父会话历史 ${Math.ceil(metadata.size / 1048576)}MiB，超过原生完整继承预算 ${Math.ceil(budget / 1048576)}MiB；已在复制前拒绝此 spawn_agent。请保留当前任务，改用 fork_turns="none"，传入必要路径、目标、约束与已完成步骤；确需完整上下文先走受保护的精简分支。不要重复原样重试，不要删除或改写原会话。`);
    return memoryAllows(metadata.size);
  } catch {
    return blocked('subagent_history_unverified: 无法安全核实父会话历史大小，未执行完整继承。请使用 fork_turns="none" 的自包含任务，或先建立受保护的有界分支。');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let bytes = 0, chunks = [];
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw Error('oversized');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const lowerLimit = Number(process.env.CODEX_WEB_SUBAGENT_HISTORY_LIMIT_BYTES);
    const result = evaluateSubagentHistory(input, { limit: Number.isFinite(lowerLimit) && lowerLimit > 0 ? Math.min(lowerLimit, HISTORY_LIMIT) : HISTORY_LIMIT });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // An ordinary hook exception can fail open. Exit 2 is an explicit native
    // denial, including malformed or oversized input; never emit its contents.
    process.stderr.write('subagent_history_unverified: 子代理保护参数无法验证；请显式使用 fork_turns="none" 后重试。\n');
    process.exitCode = 2;
  }
}
