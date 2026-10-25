// Run as an independent systemd user service, not an agent's shell child.
// Normally wait for the protected conversation to finish. --now is reserved
// for the user's explicit permission to interrupt it; it is still never resumed.
// Snapshot before restarting, then resume the other interrupted conversations.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const { createRequire } = require('node:module');
const { captureAuthFailures, persistAuthFailures } = require('./preserve-auth-failures.cjs');
const root = path.resolve(__dirname, '..');
const WebSocket = createRequire(path.join(root, 'package.json'))('ws');
const protectedThread = process.argv[process.argv.indexOf('--after-thread') + 1];
const allIdle = process.argv.includes('--all-idle');
const verificationIndex = process.argv.indexOf('--verify-authorization');
const authorizationSession = verificationIndex < 0 ? null : process.argv[verificationIndex + 1];
if (verificationIndex >= 0 && !/^[a-f0-9-]{36}$/i.test(authorizationSession ?? '')) throw new Error('Invalid authorization verification session');
if (!process.argv.includes('--after-thread') || !/^[a-f0-9-]{36}$/i.test(protectedThread ?? '')) {
  throw new Error('Required: --after-thread <current-thread-id> [--check] [--now] [--restart-ui]');
}
const endpoint = 'ws://127.0.0.1:4576/ws';
const dbPath = path.join(root, 'data/backend/codex-web.sqlite');
function cookie(user) {
  const p = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + 600000 })).toString('base64url');
  const s = crypto.createHmac('sha256', fs.readFileSync(path.join(root, 'data/auth/session-secret'), 'utf8').trim()).update(p).digest('base64url');
  return 'codex_remote_session_4575=' + p + '.' + s;
}
function connect(user, action) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, { headers: { cookie: cookie(user) } });
    const finish = (error, value) => { clearTimeout(timer); ws.close(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Deployment socket timeout')); }, 15000);
    ws.once('error', error => finish(error));
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello') {
        if (action) ws.send(JSON.stringify(action));
        else finish(null, m.data?.liveState?.activeTurns ?? []);
      }
      if (action && m.requestId === action.requestId && ['ack', 'error'].includes(m.type)) finish(null, m);
    });
  });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));
function authorizationStatus(sessionId) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(root, 'data/backend/auth-control.sock'));
    let data = '';
    const fail = () => { socket.destroy(); reject(new Error('Authorization verification endpoint unavailable')); };
    socket.setTimeout(5000, fail); socket.once('error', fail);
    socket.once('connect', () => socket.write(JSON.stringify({ action: 'status', sessionId }) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 8192) return fail();
      if (!data.includes('\n')) return;
      try { const result = JSON.parse(data.split('\n')[0]); socket.destroy(); result.ok ? resolve(result.data) : reject(new Error('Authorization status unavailable')); }
      catch { fail(); }
    });
  });
}
async function run() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const owner = db.prepare('SELECT user_id FROM thread_owners WHERE thread_id=?').get(protectedThread);
    if (!owner) throw new Error('Protected conversation owner not found');
    const busy = async () => (await connect(owner.user_id)).some(t => t.threadId === protectedThread);
    if (process.argv.includes('--check')) {
      log('deployment_check', { protectedThread, waitingForCurrentTurn: await busy() }); return;
    }
    // An explicitly requested all-idle deployment must not silently expire
    // while long-running user conversations are still making progress.
    const deadline = allIdle ? Number.POSITIVE_INFINITY : Date.now() + 30 * 60_000;
    const immediate = process.argv.includes('--now');
    log(immediate ? 'authorized_immediate_deployment' : 'waiting_for_current_conversation', { protectedThread });
    let active;
    for (;;) {
      if (Date.now() >= deadline) throw new Error('Deployment deferred: current conversation still running; no restart performed');
      if (!immediate) {
        if (await busy()) { await pause(2000); continue; }
        await pause(1500);
        if (await busy()) continue;
      }
      active = [];
      for (const { id: user } of db.prepare('SELECT id FROM users').all()) {
        for (const turn of await connect(user)) {
          const thread = db.prepare('SELECT project_id FROM thread_owners WHERE thread_id=? AND user_id=?').get(turn.threadId, user);
          if (!thread) throw new Error('Active conversation ownership unavailable; no restart performed');
          if (turn.threadId !== protectedThread) active.push({ ...turn, user, projectId: thread.project_id });
        }
      }
      if (allIdle && active.length) {
        log('waiting_for_all_conversations', { activeConversations: active.length });
        await pause(5000); continue;
      }
      if (immediate || !await busy()) break;
    }
    const snapshot = path.join(root, 'data/backend/deployment-active.json');
    fs.writeFileSync(snapshot, JSON.stringify({ createdAt: new Date().toISOString(), protectedThread, active }), { mode: 0o600 });
    const pool = JSON.parse(fs.readFileSync(path.join(root, 'account-pool.json'), 'utf8'));
    const stateFile = path.resolve(root, pool.stateFile ?? 'account-pool-state.json');
    // The old backend only logged terminal failures. Carry that classification
    // across deployment without issuing account/read or forcing real renewal.
    let journal;
    try {
      journal = execFileSync('journalctl', ['--user', '-u', 'codex-account-pool-4576.service', '--since', '7 days ago', '--grep', 'Account authentication requires device login', '-o', 'json', '--no-pager', '-n', '200'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      // journalctl --grep exits 1 when no records match; that is not a deployment failure.
      if (error.status !== 1 || String(error.stdout ?? '').trim() || String(error.stderr ?? '').trim()) throw error;
      journal = '';
    }
    const authFailures = captureAuthFailures(pool.accounts, journal);
    // Validate state before stopping anything; it is re-read only after the old
    // process can no longer overwrite it.
    JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (allIdle) {
      // Recheck after preparing state, not just before the (possibly slow)
      // journal read. A newly started conversation cancels this attempt.
      for (const { id: user } of db.prepare('SELECT id FROM users').all()) {
        if ((await connect(user)).length) throw new Error('Deployment deferred: new active conversation detected; no restart performed');
      }
    }
    log('restarting_backend', { interruptedConversations: active.length });
    execFileSync('systemctl', ['--user', 'stop', 'codex-account-pool-4576.service']);
    let authMigrationFailure = false;
    try {
      log('auth_failure_state_preserved', { accounts: persistAuthFailures(stateFile, authFailures) });
    } catch {
      authMigrationFailure = true;
      log('auth_failure_state_migration_failed');
    } finally {
      execFileSync('systemctl', ['--user', 'start', 'codex-account-pool-4576.service']);
    }
    let ready = false;
    for (let i = 0; i < 45; i++) {
      try { await connect(owner.user_id); ready = true; break; }
      catch { await pause(1000); }
    }
    if (!ready) throw new Error('Backend unavailable after restart; saved recovery snapshot retained');
    let uiFailure = false;
    if (process.argv.includes('--restart-ui')) {
      try {
        const uiOrigins = ['http://127.0.0.1:4575/'];
        execFileSync('systemctl', ['--user', 'restart', 'codex-account-pool-ui-4575.service']);
        // The public gateway can serve this same build on 4574. It also keeps
        // MIME/cache rules in memory, so source changes need its UI-only restart.
        const publicUiDirectory = execFileSync('systemctl', ['--user', 'show', 'codex-ui-v2.service', '-p', 'WorkingDirectory', '--value'], { encoding: 'utf8' }).trim();
        const publicUiState = execFileSync('systemctl', ['--user', 'show', 'codex-ui-v2.service', '-p', 'ActiveState', '--value'], { encoding: 'utf8' }).trim();
        if (publicUiDirectory === path.join(root, 'frontend') && publicUiState === 'active') {
          execFileSync('systemctl', ['--user', 'restart', 'codex-ui-v2.service']);
          uiOrigins.push('http://127.0.0.1:4574/');
        }
        // systemctl confirms process startup, not that the HTTP listener has
        // bound yet. Do not report a healthy restart as failed on that gap.
        let uiReady = false;
        for (let i = 0; i < 20; i++) {
          try {
            const checks = await Promise.all(uiOrigins.map(async origin => {
              const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
              await response.body?.cancel();
              return response.ok;
            }));
            if (checks.every(Boolean)) { uiReady = true; break; }
          } catch { /* Retry only the local readiness probe, not the restart. */ }
          await pause(500);
        }
        if (!uiReady) throw new Error('Frontend health check failed');
        log('frontend_restarted');
      } catch {
        uiFailure = true;
        log('frontend_restart_failed');
      }
    }
    const failures = [];
    for (const turn of active) {
      try {
      if ((await connect(turn.user)).some(t => t.threadId === turn.threadId)) {
        log('already_running', { threadId: turn.threadId }); continue;
      }
      // A WebSocket hello proves only that Node is listening. The account's
      // app-server may still be releasing/reacquiring its writer lease. Probe
      // it read-only before sending a single continuation prompt.
      const runtimeDeadline = Date.now() + 45_000;
      let runtimeReady = false;
      while (Date.now() < runtimeDeadline) {
        try {
          const probe = await connect(turn.user, { type: 'turn.queue.list', requestId: 'deployment-ready-' + crypto.randomUUID(), threadId: turn.threadId });
          if (probe.type === 'ack' && probe.ok === true) { runtimeReady = true; break; }
        } catch { /* Preserve the recovery snapshot if readiness never arrives. */ }
        await pause(1000);
      }
      if (!runtimeReady) throw new Error('Account runtime not ready; recovery snapshot retained');
      if ((await connect(turn.user)).some(t => t.threadId === turn.threadId)) {
        log('already_running', { threadId: turn.threadId }); continue;
      }
      const reply = await connect(turn.user, { type: 'turn.start', requestId: 'deployment-resume-' + crypto.randomUUID(), projectId: turn.projectId, threadId: turn.threadId, prompt: '继续' });
      log('conversation_resume', { threadId: turn.threadId, accepted: reply.type === 'ack' && reply.ok === true });
      if (reply.type !== 'ack' || reply.ok !== true) failures.push(turn.threadId);
      } catch {
        failures.push(turn.threadId);
        log('conversation_resume_failed', { threadId: turn.threadId });
      }
    }
    // Recover interrupted conversations before any optional verification can
    // fail, so an authorization problem never leaves unrelated users stopped.
    if (authorizationSession) {
      const verifyDeadline = Date.now() + 120_000;
      let status;
      while (Date.now() < verifyDeadline) {
        status = await authorizationStatus(authorizationSession);
        if (status.status === 'completed' || status.status === 'failed') break;
        await pause(2000);
      }
      if (status?.status !== 'completed') throw new Error(`Authorization handover not verified: ${status?.status ?? 'unknown'}`);
      const target = pool.accounts.find(account => account.id === status.accountId);
      if (!target) throw new Error('Verified account missing');
      const auth = JSON.parse(fs.readFileSync(path.join(target.codexHome, 'auth.json'), 'utf8'));
      const claims = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString());
      if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error('Installed access credential is expired');
      log('authorization_handover_verified', { accountId: status.accountId, lastRefresh: auth.last_refresh, expiresAt: new Date(claims.exp * 1000).toISOString() });
    }
    log('deployment_complete', { resumedConversations: active.length - failures.length, failedConversations: failures.length });
    if (failures.length) throw new Error('Some conversations could not resume; recovery snapshot retained');
    if (uiFailure) throw new Error('Conversations resumed, but frontend needs recovery');
    if (authMigrationFailure) throw new Error('Conversations resumed, but authentication state needs verification');
  } finally { db.close(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
