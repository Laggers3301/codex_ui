import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, identity, descendants } from './resource-guardian.mjs';
const base = { pid: 1, ppid: 0, start: '44', exe: '/usr/bin/python3', args: [],
  cwd: '/home/example/codex_zerotier_remote/users/test-user/project', cgroup: '/session-2.scope', rss: 1024, name: 'python' };
test('VS Code, Cursor and Windsurf remote servers are editors', () => {
  for (const dir of ['.vscode-server', '.vscode-server-insiders', '.cursor-server', '.windsurf-server'])
    assert.equal(classify({ ...base, exe: `/home/example/${dir}/bin/node` }), 'editor');
  assert.equal(classify({ ...base, exe: '/usr/bin/node', args: ['/home/example/.vscode-server/server/out/bootstrap-fork', '--type=extensionHost'] }), 'editor');
  assert.notEqual(classify({ ...base, exe: '/usr/bin/node', args: ['-e', 'console.log("/home/example/.vscode-server/anything")'] }), 'editor');
});
test('manual jobs guarded; web, speech and monitor services exempt', () => {
  assert.equal(classify(base), 'job');
  assert.equal(classify({ ...base, cwd: '/usr/lib' }), null);
  for (const unit of ['codex-account-pool-4576', 'codex-remote', 'codex-speech-tunnel', 'codex-resource-guardian'])
    assert.equal(classify({ ...base, cgroup: `/app.slice/${unit}.service` }), null);
});
test('language servers and terminal descendants belong to editor, unrelated SSH does not', () => {
  const list = [{ ...base, pid: 10, ppid: 9 }, { ...base, pid: 11, ppid: 10 },
    { ...base, pid: 12, ppid: 11 }, { ...base, pid: 13, ppid: 9 }];
  assert.deepEqual(descendants(10, list).map(p => p.pid), [10, 11, 12]);
});
test('telemetry never writes arguments/secrets', () => {
  const logged = identity({ ...base, args: ['--token', 'SECRET'] });
  assert.equal(logged.owner, 'test-user');
  assert.equal(JSON.stringify(logged).includes('SECRET'), false);
  assert.equal('args' in logged, false);
});
