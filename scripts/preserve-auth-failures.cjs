// Bridge an old backend's journal-only auth classification into the new
// persistent latch. This reads local state only; it never refreshes/logs tokens.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const terminalCodes = new Set(['refresh_token_reused', 'refresh_token_invalidated', 'refresh_token_expired']);

function credentialIdentity(home) {
  let fd;
  try {
    fd = fs.openSync(path.join(home, 'auth.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 1024 * 1024) return null;
    const auth = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const after = fs.fstatSync(fd);
    if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) return null;
    const token = auth.tokens?.refresh_token;
    if (typeof token !== 'string' || !token || /api|key/i.test(String(auth.auth_mode ?? ''))) return null;
    return { stamp: after.mtimeMs, fingerprint: crypto.createHash('sha256').update('refresh-token\0').update(token).digest('hex') };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function captureAuthFailures(accounts, journal) {
  const latest = new Map();
  for (const line of journal.split('\n')) {
    try {
      const row = JSON.parse(line);
      const message = JSON.parse(row.MESSAGE);
      if (message.requiresLogin !== true || !terminalCodes.has(message.code)) continue;
      const timestamp = Number(row.__REALTIME_TIMESTAMP) / 1000;
      if (!Number.isFinite(timestamp)) continue;
      const old = latest.get(message.accountId);
      if (!old || old.timestamp < timestamp) latest.set(message.accountId, { code: message.code, timestamp });
    } catch { /* Ignore non-classified or incomplete journal records. */ }
  }
  return accounts.filter(account => account.enabled !== false && account.kind !== 'api-provider').flatMap(account => {
    const failure = latest.get(account.id);
    const credential = failure && credentialIdentity(account.codexHome);
    // A file written after the failure could be a new login. Do not bind an old
    // journal error to an identity which was not present at that time.
    if (!failure || !credential || credential.stamp > failure.timestamp) return [];
    return [{ id: account.id, home: account.codexHome, code: failure.code, ...credential }];
  });
}

function persistAuthFailures(stateFile, captured) {
  const confirmed = captured.filter(item => credentialIdentity(item.home)?.fingerprint === item.fingerprint);
  if (!confirmed.length) return 0;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid account-pool state; auth latch migration refused');
  state.authFailures = { ...state.authFailures };
  for (const item of confirmed) state.authFailures[item.id] = { code: item.code, credentialVersion: item.stamp, credentialFingerprint: item.fingerprint };
  const temporary = `${stateFile}.auth-migration-${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(temporary, stateFile); }
  catch (error) { fs.unlinkSync(temporary); throw error; }
  return confirmed.length;
}

module.exports = { captureAuthFailures, persistAuthFailures };
