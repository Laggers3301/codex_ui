import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
export const guardMatcher = '^(spawn_agent|Agent|collaboration[.]?spawn_agent)$';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const guardCommand = `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./subagent-history-guard.mjs', import.meta.url)))}`;
export function installSubagentHistoryGuard(home) {
  const file = path.join(home, 'hooks.json');
  let previous = {};
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) throw Error('Invalid runtime hooks file');
    previous = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw Error('Invalid runtime hooks config');
  const hooks = previous.hooks ?? {};
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw Error('Invalid runtime hooks mapping');
  const groups = hooks.PreToolUse ?? [];
  if (!Array.isArray(groups)) throw Error('Invalid PreToolUse config');
  if (groups.some(group => group.matcher === guardMatcher && group.hooks?.some(hook => hook.type === 'command' && hook.command === guardCommand && hook.timeout === 5))) return { path: file, changed: false };
  const next = { ...previous, hooks: { ...hooks, PreToolUse: [...groups, { matcher: guardMatcher, hooks: [{ type: 'command', command: guardCommand, timeout: 5, statusMessage: 'Checking subagent history budget' }] }] } };
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return { path: file, changed: true };
}
