const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { captureAuthFailures, persistAuthFailures } = require('./preserve-auth-failures.cjs');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-latch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'fixture-only-token' } }));
  const state = path.join(home, 'state.json');
  const prior = { threadAccounts: { thread: 'a' }, quotaSnapshots: { a: { limits: { remaining: 10 } } } };
  fs.writeFileSync(state, JSON.stringify(prior));
  const row = (code, timestamp = Date.now() + 1000) => JSON.stringify({ __REALTIME_TIMESTAMP: timestamp * 1000, MESSAGE: JSON.stringify({ accountId: 'a', code, requiresLogin: true }) });
  return { home, auth, state, prior, row, accounts: [{ id: 'a', codexHome: home }] };
}

test('persists the classified failure without modifying credentials or thread/quota state', t => {
  const f = fixture(t);
  const authBefore = fs.readFileSync(f.auth);
  const captured = captureAuthFailures(f.accounts, f.row('refresh_token_reused'));
  assert.equal(captured.length, 1);
  assert.equal(persistAuthFailures(f.state, captured), 1);
  const state = JSON.parse(fs.readFileSync(f.state, 'utf8'));
  assert.deepEqual(state.threadAccounts, f.prior.threadAccounts);
  assert.deepEqual(state.quotaSnapshots, f.prior.quotaSnapshots);
  assert.equal(state.authFailures.a.code, 'refresh_token_reused');
  assert.match(state.authFailures.a.credentialFingerprint, /^[a-f\d]{64}$/);
  assert.ok(fs.readFileSync(f.auth).equals(authBefore));
  assert.equal(fs.statSync(f.state).mode & 0o777, 0o600);
});

test('does not attach an old error to credentials written after that error', t => {
  const f = fixture(t);
  assert.deepEqual(captureAuthFailures(f.accounts, f.row('refresh_token_invalidated', fs.statSync(f.auth).mtimeMs - 100)), []);
});

test('rechecks identity after shutdown, even if the mtime is unchanged', t => {
  const f = fixture(t);
  const captured = captureAuthFailures(f.accounts, f.row('refresh_token_invalidated'));
  const stamp = fs.statSync(f.auth);
  fs.writeFileSync(f.auth, JSON.stringify({ tokens: { refresh_token: 'replacement-fixture' } }));
  fs.utimesSync(f.auth, stamp.atime, stamp.mtime);
  assert.equal(persistAuthFailures(f.state, captured), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)), f.prior);
});

test('ignores malformed records, unknown codes, API providers, and credential symlinks', t => {
  const f = fixture(t);
  assert.deepEqual(captureAuthFailures(f.accounts, 'bad\n' + f.row('network_error')), []);
  assert.deepEqual(captureAuthFailures([{ ...f.accounts[0], kind: 'api-provider' }], f.row('refresh_token_expired')), []);
  const actual = path.join(f.home, 'actual-auth.json');
  fs.renameSync(f.auth, actual); fs.symlinkSync(actual, f.auth);
  assert.deepEqual(captureAuthFailures(f.accounts, f.row('refresh_token_reused')), []);
});
