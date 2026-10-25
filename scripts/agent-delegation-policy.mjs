import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const delegationContextInstructions = [
  '## 子代理上下文预算 / Subagent context budget',
  '',
  '- 独立审计、检索、实现等可用自包含任务描述完成的子任务，默认显式设置 fork_turns="none"；传入目标、必要文件路径、约束及交付要求，不因方便而复制完整主会话。子代理同样遵循此约定。',
  '- 长期或已知超大会话不得直接用 fork_turns="all" 创建子代理。确需继承上下文时先通过受保护的会话分支／工具结果归档流程准备有界上下文；保留原会话，不自行改写、删除历史或加密记录。用户明确要求完整继承时先说明资源风险，不偷偷改成无历史。',
  '- 不要因创建子代理长时间未返回而重复创建同名任务；先核查已有代理和运行状态。以上为模型操作约定，不代表运行时已硬性阻止所有超大原生分支。'
].join('\n');

// Also used by the JS launcher: an already-running older backend may rewrite
// its older managed block before a cold start. Restore just this managed policy
// before Codex starts, without changing credentials, config or user instructions.
export function ensureDelegationPolicy(home) {
  const read = file => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 256 * 1024) throw Error('Invalid managed instructions file');
      return fs.readFileSync(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  const override = path.join(home, 'AGENTS.override.md');
  const file = read(override).trim() ? override : path.join(home, 'AGENTS.md');
  const text = read(file);
  if (text.includes(delegationContextInstructions)) return 'unchanged';
  const start = '<!-- codex-web:response-language:start -->';
  const end = '<!-- codex-web:response-language:end -->';
  if (!text.includes(start) || !text.includes(end) || text.indexOf(start) > text.indexOf(end)) return 'missing_managed_block';
  const next = text.replace(end, `${delegationContextInstructions}\n${end}`);
  const temporary = `${file}.delegation-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, next, { flag: 'wx', mode: fs.statSync(file).mode & 0o777 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return 'installed';
}
