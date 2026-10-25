import path from 'node:path';
import type { CodexBridge } from './codexBridge.js';
import { AppError } from './appErrors.js';
import { guardCommand, guardMatcher } from '../scripts/install-subagent-history-guard.mjs';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
/** Trust only our exact installed definition, never arbitrary project/global
 * commands. This trust remains a per-session config overlay, not a credential. */
export async function withSubagentHistoryGuard(bridge: CodexBridge, home: string, params: unknown): Promise<Record<string, unknown>> {
  const input = record(params);
  // The guard is account-global. Do not traverse an unrelated user's project
  // or a slow/disconnected remote mount just to discover this known source.
  const response = record(await bridge.request('hooks/list', { cwds: [home] }, 10_000));
  const state: Record<string, { trusted_hash: string; enabled: true }> = {};
  for (const entry of Array.isArray(response.data) ? response.data : []) {
    for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
      if (String(hook.eventName).toLowerCase() === 'pretooluse' && hook.matcher === guardMatcher && hook.command === guardCommand && hook.async !== true
        && typeof hook.sourcePath === 'string' && path.resolve(hook.sourcePath) === path.join(home, 'hooks.json')
        && typeof hook.key === 'string' && typeof hook.currentHash === 'string') state[hook.key] = { trusted_hash: hook.currentHash, enabled: true };
    }
  }
  if (!Object.keys(state).length) throw new AppError('subagent_guard_unavailable', '子代理历史保护尚未加载，已暂停启动以避免内存耗尽。请稍后重试。');
  const config = record(input.config);
  return { ...input, config: { ...config, 'features.hooks': true, 'hooks.state': { ...record(config['hooks.state']), ...state } } };
}
