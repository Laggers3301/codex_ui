// Invoked under flock. The parent owns the lease; agent tools do not inherit it.
// stdout remains the native JSON-RPC stream. Diagnostics contain no credentials.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Missing account runtime command');
const home = process.env.CODEX_HOME;
const diagnostic = (event, fields = {}) => process.stderr.write(`[account-runtime] ${JSON.stringify({ event, runtimePid: process.pid, ...fields })}\n`);
function metadata() {
  try {
    const file = path.join(home, 'auth.json');
    const stat = fs.statSync(file);
    if (stat.size > 128 * 1024) return { state: 'invalid' };
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    const refresh = auth.tokens?.refresh_token;
    const lastRefresh = typeof auth.last_refresh === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(auth.last_refresh) ? auth.last_refresh : null;
    return { state: 'present', mtime: stat.mtimeMs, lastRefresh,
      // This stays in memory; neither tokens nor their digests go to logs.
      fingerprint: typeof refresh === 'string' ? crypto.createHash('sha256').update(refresh).digest('hex') : null };
  } catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'invalid' }; }
}
let previous = home ? metadata() : null;
const child = spawn(command, args, { stdio: 'inherit', env: process.env });
diagnostic('started', { nativePid: child.pid, authState: previous?.state, lastRefresh: previous?.lastRefresh });
let watcher, debounce, killTimer;
if (home) {
  try {
    watcher = fs.watch(home, { persistent: false }, (_event, filename) => {
      if (String(filename) !== 'auth.json') return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const next = metadata();
        if (JSON.stringify(next) === JSON.stringify(previous)) return;
        diagnostic('credentials_changed', { nativePid: child.pid, authState: next.state,
          previousRefresh: previous?.lastRefresh, lastRefresh: next.lastRefresh,
          refreshTokenChanged: next.fingerprint !== previous?.fingerprint });
        previous = next;
      }, 150);
      debounce.unref();
    });
    watcher.on('error', () => diagnostic('watch_failed'));
  } catch { diagnostic('watch_failed'); }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  child.kill(signal);
  killTimer ??= setTimeout(() => child.kill('SIGKILL'), 10_000);
  killTimer.unref();
});
function finish(code) {
  watcher?.close(); clearTimeout(debounce); clearTimeout(killTimer);
  process.exit(code);
}
child.on('error', error => { diagnostic('spawn_failed', { code: error.code }); finish(1); });
child.on('exit', (code, signal) => {
  diagnostic('exited', { nativePid: child.pid, code, signal });
  finish(code ?? (signal === 'SIGINT' ? 130 : 143));
});
