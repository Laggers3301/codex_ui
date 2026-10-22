import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
const client = new URL('./device-authorize-account.mjs', import.meta.url);

async function run(args, result) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-client-fixture-'));
 const actions = [];
 const server = net.createServer(socket => { let data = ''; socket.on('data', chunk => {
  data += chunk; if (!data.includes('\n')) return;
  actions.push(JSON.parse(data.split('\n')[0])); socket.end(JSON.stringify({ ok: true, data: result }) + '\n');
 }); });
 await new Promise(resolve => server.listen(path.join(root, 'auth-control.sock'), resolve));
 let child;
 try {
  child = spawn(process.execPath, [client.pathname, ...args], { env: { ...process.env, CODEX_WEB_DATA_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  clearTimeout(timer);
  return { code, output, actions };
 } finally { child?.kill(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}
test('device code client exits without becoming a background-terminal handover blocker', async () => {
 const result = await run(['fixture'], { id: 'fixture-session', status: 'awaiting_authorization', userCode: 'TEST-CODE', verificationUrl: 'https://auth.openai.com/codex/device' });
 assert.equal(result.code, 0);
 assert.deepEqual(result.actions, [{ action: 'start', accountId: 'fixture' }]);
 assert.match(result.output, /observer exits now/);
});
test('single status check does not start another authorization', async () => {
 const id = '00000000-0000-0000-0000-000000000001';
 const result = await run(['--status', id], { id, status: 'completed' });
 assert.equal(result.code, 0);
 assert.deepEqual(result.actions, [{ action: 'status', sessionId: id }]);
 assert.equal(JSON.parse(result.output).status, 'completed');
});
