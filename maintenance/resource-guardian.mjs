import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
const MiB = 1024 ** 2;
const uid = process.getuid();
const roots = /\/(?:\.vscode-server|\.vscode-server-insiders|\.cursor-server|\.windsurf-server)\//;
const guarded = /\/resource-guard-[\w-]+\.scope$/;
export const manualWorkspaceRoot = path.resolve(process.env.CODEX_WEB_USER_WORKSPACE_ROOT ?? new URL('../data/users', import.meta.url).pathname);
export async function text(file) { try { return await fs.readFile(file, 'utf8'); } catch { return ''; } }
export function identity(p) {
  // Never persist argv: it may contain access tokens, passwords or user prompts.
  const owner = path.relative(manualWorkspaceRoot, p.cwd).match(/^([\w-]+)(?:[\\/]|$)/)?.[1] ?? null;
  return { pid: p.pid, ppid: p.ppid, start: p.start, exe: p.exe, entry: p.entry,
    cwd: p.cwd, cgroup: p.cgroup, owner,
    rssMb: Math.round(p.rss / MiB), name: p.name };
}
export function classify(p) {
  if (/\/(?:codex-account-pool[^/]*|codex-remote|codex-ui-v2|codex-speech-tunnel|codex-pool-watchdog|codex-resource-guardian)\.service(?:\/|$)/.test(p.cgroup)) return null;
  if (roots.test(p.exe) || p.args.some(a => a.startsWith('/') && roots.test(a))) return 'editor';
  // Only manual project jobs, not shared system/desktop services or the web backends.
  if (!p.cwd.startsWith(manualWorkspaceRoot + path.sep) || !/^[\w-]+\//.test(path.relative(manualWorkspaceRoot, p.cwd))) return null;
  if (p.args.some(a => /(?:pool-watchdog|resource-guardian|run-account-runtime|run-backend|server\/index|backend\/dist|restart-backend)/.test(a))) return null;
  if (/^(?:python[\d.]*|node|java|cargo|rustc|gcc|g\+\+|cc1plus|cc1|clang[\w+.-]*|make|ninja|cmake|git|wget|curl|tar|gzip|zstd|ffmpeg)$/.test(path.basename(p.exe))) return 'job';
  return null;
}
export function descendants(root, processes) {
  const ids = new Set([root]);
  let changed = true;
  while (changed) { changed = false; for (const p of processes) if (ids.has(p.ppid) && !ids.has(p.pid)) { ids.add(p.pid); changed = true; } }
  return processes.filter(p => ids.has(p.pid));
}
export async function processes() {
  const names = (await fs.readdir('/proc')).filter(n => /^\d+$/.test(n));
  const result = [];
  // Bounded parallel /proc reads, no recursive filesystem walk or remote mounts.
  for (let i = 0; i < names.length; i += 24) await Promise.all(names.slice(i, i + 24).map(async name => {
    const base = `/proc/${name}`, status = await text(`${base}/status`);
    if (Number(status.match(/^Uid:\s+(\d+)/m)?.[1]) !== uid) return;
    const stat = await text(`${base}/stat`), end = stat.lastIndexOf(')'), fields = stat.slice(end + 2).split(' ');
    if (end < 0) return;
    let exe = '', cwd = '';
    try { [exe, cwd] = await Promise.all([fs.readlink(`${base}/exe`), fs.readlink(`${base}/cwd`)]); } catch { return; }
    const args = (await text(`${base}/cmdline`)).split('\0').filter(Boolean);
    result.push({ pid: Number(name), ppid: Number(fields[1]), start: fields[19], exe, cwd, args,
      entry: args.filter(a => /\.(?:mjs|cjs|js|ts|py)$/.test(a)).at(-1) ? path.basename(args.filter(a => /\.(?:mjs|cjs|js|ts|py)$/.test(a)).at(-1)) : null,
      name: status.match(/^Name:\s+(.+)/m)?.[1],
      rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
      cgroup: (await text(`${base}/cgroup`)).match(/^0::(.+)$/m)?.[1] ?? '' });
  }));
  return result;
}
export async function bounded(p) {
  if (guarded.test(p.cgroup)) return true;
  let group = p.cgroup;
  while (group && group !== '/') {
    // Ignore host/user-wide limits: they do not isolate an individual job.
    if (/\.(?:service|scope)$/.test(group) && !/\/(?:user@\d+\.service|session-\d+\.scope)$/.test(group)) {
      const max = (await text(`/sys/fs/cgroup${group}/memory.max`)).trim();
      if (max && max !== 'max') return true;
    }
    group = path.dirname(group);
  }
  return false;
}
function log(event, extra) { console.log(JSON.stringify({ time: new Date().toISOString(), event, ...extra })); }
async function bus(method, signature, args) {
  return run('/usr/bin/busctl', ['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', method, signature, ...args.map(String)], { timeout: 4000, maxBuffer: 65536 });
}
export async function contain(p, tree, type, limits = {}) {
  const unit = `resource-guard-${type}-${p.pid}-${p.start}.scope`;
  const max = limits.max ?? (type === 'editor' ? 3 * 1024 * MiB : 1536 * MiB);
  const high = limits.high ?? (type === 'editor' ? 2 * 1024 * MiB : 1024 * MiB);
  const props = [
    ['Description', 's', `Bounded ${type} process tree ${p.pid}`],
    ['Slice', 's', 'codex-auxiliary.slice'], ['PIDs', 'au', tree.length, ...tree.map(x => x.pid)],
    ['MemoryAccounting', 'b', 'true'], ['MemoryHigh', 't', high], ['MemoryMax', 't', max],
    ['MemorySwapMax', 't', limits.swap ?? 128 * MiB], ['TasksMax', 't', type === 'editor' ? 512 : 256],
    ['CPUWeight', 't', 50], ['IOWeight', 't', 25]
  ];
  await bus('StartTransientUnit', 'ssa(sv)a(sa(sv))', [unit, 'fail', props.length, ...props.flat(), 0]);
  const { stdout } = await run('/usr/bin/systemctl', ['--user', 'show', unit, '--value', '-p', 'ControlGroup'], { timeout: 4000 });
  const cgroup = stdout.trim();
  if (!cgroup.endsWith(`/${unit}`)) throw new Error(`Scope creation failed: ${unit}`);
  // systemd 249 lacks the newer MemoryOOMGroup property; use its delegated
  // kernel control directly. This is a cgroup knob, not an application file.
  await fs.writeFile(`/sys/fs/cgroup${cgroup}/memory.oom.group`, '1');
  for (const x of tree) {
    const actual = await text(`/proc/${x.pid}/cgroup`);
    if (actual && !actual.includes(`/${unit}`)) throw new Error(`PID ${x.pid} not contained`);
  }
  log('contained', { unit, type, memoryMaxMb: max / MiB, memoryHighMb: high / MiB,
    processes: tree.map(identity) });
  return { unit, cgroup };
}
let sampling = false;
const lastScopes = new Map();
export async function sample() {
  if (sampling) return;
  sampling = true;
  try {
    const all = await processes(), candidates = [];
    for (const p of all) {
      if (p.pid === process.pid || guarded.test(p.cgroup)) continue;
      const type = classify(p);
      if (!type || (type !== 'editor' && await bounded(p))) continue;
      // Editors are caught as soon as their server appears. Manual jobs are
      // isolated when their whole tree reaches 256 MiB, or runs a downloader.
      const tree = descendants(p.pid, all);
      if (type === 'job' && tree.reduce((n, x) => n + x.rss, 0) < 256 * MiB
        && !/^(?:wget|curl)$/.test(path.basename(p.exe))) continue;
      candidates.push({ p, type, tree });
    }
    const selected = candidates.filter(x => !candidates.some(y => y !== x && y.tree.some(z => z.pid === x.p.pid)));
    for (const { p, type, tree } of selected) {
      // Check PID start time again to avoid moving a recycled PID.
      const now = await text(`/proc/${p.pid}/stat`);
      if (now.slice(now.lastIndexOf(')') + 2).split(' ')[19] !== p.start) continue;
      try { await contain(p, tree, type); }
      catch (e) { log('containment-error', { process: identity(p), error: e.message }); }
    }
    const mem = await text('/proc/meminfo'), available = Number(mem.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? 0) / 1024;
    const pressure = Number((await text('/proc/pressure/memory')).match(/^full\s+avg10=([\d.]+)/m)?.[1] ?? 0);
    const disk = await fs.statfs('/');
    const availableDiskGiB = disk.bavail * disk.bsize / 1024 ** 3;
    const fresh = await processes();
    const groups = new Set(fresh.map(p => p.cgroup).filter(g => guarded.test(g)));
    for (const group of groups) {
      const unit = path.basename(group), root = `/sys/fs/cgroup${group}`;
      // Repair children forked in the short snapshot-to-migration window.
      const extra = new Map();
      for (const member of fresh.filter(p => p.cgroup === group)) {
        for (const child of descendants(member.pid, fresh)) {
          if (child.cgroup !== group && !guarded.test(child.cgroup)
            && !/\/codex-[^/]+\.service(?:\/|$)/.test(child.cgroup)) extra.set(child.pid, child);
        }
      }
      if (extra.size) {
        const valid = [];
        for (const p of extra.values()) {
          const currentStat = await text(`/proc/${p.pid}/stat`);
          if (currentStat.slice(currentStat.lastIndexOf(')') + 2).split(' ')[19] === p.start) valid.push(p.pid);
        }
        if (valid.length) {
          await bus('AttachProcessesToUnit', 'ssau', [unit, '', valid.length, ...valid]);
          log('attached-late-descendants', { unit, processes: valid.map(pid => identity(extra.get(pid))) });
        }
      }
      const events = await text(`${root}/memory.events`), oom = Number(events.match(/^oom_kill\s+(\d+)/m)?.[1] ?? 0);
      const current = Number((await text(`${root}/memory.current`)).trim()) / MiB;
      const old = lastScopes.get(group);
      const emergency = (available < 384 || pressure > 60) && current > 768;
      const diskEmergency = unit.startsWith('resource-guard-job-') && availableDiskGiB < 32;
      if (oom > (old?.oom ?? 0) || emergency || diskEmergency) {
        log('stop-contained-group', { unit, oomKills: oom, availableMb: available, memoryMb: current, pressure, availableDiskGiB });
        // Only our explicit allowlisted editor/job scopes. Never restart web,
        // SSH, cloudflared, account runtimes, or the machine.
        await run('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 6000 });
      } else if (!old || Date.now() - old.reportAt > 60000) {
        log('group-status', { unit, memoryMb: Math.round(current), oomKills: oom });
      }
      lastScopes.set(group, { oom, reportAt: !old || Date.now() - old.reportAt > 60000 ? Date.now() : old.reportAt });
    }
    for (const g of lastScopes.keys()) if (!groups.has(g)) lastScopes.delete(g);
  } catch (e) { log('guardian-error', { error: e.message }); }
  finally { sampling = false; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await sample();
  if (!process.argv.includes('--once')) setInterval(() => void sample(), 5000);
}
