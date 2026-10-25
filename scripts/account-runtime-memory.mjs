import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Cold starts may still be launched by an older backend. Upgrade only its
// exact legacy per-account watermark; never change a hard or aggregate limit.
export function normalizeLegacyAccountWatermark(read = file => fs.readFileSync(file, 'utf8'), run = spawnSync) {
  try {
    const relative = read('/proc/self/cgroup').split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!relative || !/^\/user\.slice\/user-\d+\.slice\/user@\d+\.service\/codex\.slice\/codex-workers\.slice\/codex-agent-[A-Za-z0-9-]+\.scope$/.test(relative)) return 'not_owned';
    const directory = `/sys/fs/cgroup${relative}`;
    const high = read(`${directory}/memory.high`).trim();
    const max = read(`${directory}/memory.max`).trim();
    if (high !== '3221225472' || max !== '4294967296') return 'unchanged';
    const unit = relative.split('/').at(-1);
    const result = run('/usr/bin/systemctl', ['--user', 'set-property', '--runtime', unit, 'MemoryHigh=4G'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error || result.status !== 0) return 'update_failed';
    return read(`${directory}/memory.high`).trim() === max ? 'normalized' : 'verification_failed';
  } catch { return 'unavailable'; }
}
