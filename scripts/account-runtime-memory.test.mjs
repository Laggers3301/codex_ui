import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLegacyAccountWatermark } from './account-runtime-memory.mjs';
const relative = '/user.slice/user-1000.slice/user@1000.service/codex.slice/codex-workers.slice/codex-agent-100004-abcd1234.scope';
function fixture(high = '3221225472', max = '4294967296', group = relative) {
  const calls = [];
  const read = file => file === '/proc/self/cgroup' ? `0::${group}\n` : file.endsWith('/memory.high') ? high : max;
  const run = (command, args) => { calls.push({ command, args }); high = max; return { status: 0 }; };
  return { read, run, calls };
}
test('normalizes only the legacy owned watermark without touching max, swap or parent', () => {
  const f = fixture();
  assert.equal(normalizeLegacyAccountWatermark(f.read, f.run), 'normalized');
  assert.deepEqual(f.calls, [{ command: '/usr/bin/systemctl', args: ['--user', 'set-property', '--runtime', 'codex-agent-100004-abcd1234.scope', 'MemoryHigh=4G'] }]);
  assert.equal(normalizeLegacyAccountWatermark(f.read, f.run), 'unchanged');
  assert.equal(f.calls.length, 1);
});
test('preserves explicit administrator limits', () => {
  for (const [high, max] of [['2147483648', '4294967296'], ['3221225472', '8589934592'], ['max', 'max']]) {
    const f = fixture(high, max); assert.equal(normalizeLegacyAccountWatermark(f.read, f.run), 'unchanged'); assert.equal(f.calls.length, 0);
  }
});
test('does not operate outside the owned account scope', () => {
  for (const group of ['/', '/user.slice/app.slice/example.scope', `${relative}/../../other.scope`]) {
    const f = fixture(undefined, undefined, group); assert.equal(normalizeLegacyAccountWatermark(f.read, f.run), 'not_owned'); assert.equal(f.calls.length, 0);
  }
});
test('reports failures instead of pretending the property changed', () => {
  const f = fixture(); assert.equal(normalizeLegacyAccountWatermark(f.read, () => ({status: 1})), 'update_failed');
  assert.equal(normalizeLegacyAccountWatermark(f.read, () => ({status: 0})), 'verification_failed');
  assert.equal(normalizeLegacyAccountWatermark(() => { throw Error('fixture'); }, f.run), 'unavailable');
});
