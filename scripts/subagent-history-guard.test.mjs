import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSubagentHistory, subagentMemoryHeadroom, HISTORY_LIMIT } from './subagent-history-guard.mjs';
import { installSubagentHistoryGuard, guardCommand } from './install-subagent-history-guard.mjs';
test('blocks oversized full inheritance without reading the history, preserves small forks and no-history agents', () => {
  const fixture = { hook_event_name: 'PreToolUse', tool_name: 'spawn_agent', transcript_path: '/runtime/sessions/parent.jsonl', tool_input: {fork_turns: 'all'} };
  const io = { home: '/runtime', realpath: value => value, stat: () => ({isFile: () => true, size: HISTORY_LIMIT}), headroom: Infinity };
  assert.equal(evaluateSubagentHistory(fixture, io).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(evaluateSubagentHistory({...fixture, tool_name: 'collaborationspawn_agent'}, io).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(evaluateSubagentHistory({...fixture, tool_input: {fork_turns: 'none'}}, io), {});
  assert.equal(evaluateSubagentHistory({...fixture, tool_input: {fork_context: false}}, io).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(evaluateSubagentHistory({...fixture, tool_input: {fork_turns: 'none',fork_context: true}}, io).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(evaluateSubagentHistory(fixture, {...io, stat: () => ({isFile: () => true, size: 4096})}), {});
  assert.equal(evaluateSubagentHistory({...fixture, tool_input: {}}, io).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(evaluateSubagentHistory({...fixture, transcript_path: '/other-user/private.jsonl'}, io).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(evaluateSubagentHistory({...fixture, transcript_path: null}, io).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(evaluateSubagentHistory({...fixture, tool_name: 'exec'}, io), {});
  assert.equal(evaluateSubagentHistory({...fixture, tool_input:{fork_turns:'none'}}, {...io,headroom:128*1024*1024}).hookSpecificOutput.permissionDecision,'deny');
});
test('child admission uses owned hard limits and the shared planning budget without modifying either', () => {
  const group='/user.slice/user-1000.slice/user@1000.service/codex.slice/codex-workers.slice/codex-agent-test-abcd.scope';
  const read=file=>file==='/proc/self/cgroup'?`0::${group}\n`:file.endsWith('memory.current')?'1000':file.endsWith('memory.high')?'1500':'4000';
  assert.equal(subagentMemoryHeadroom(read),500);
  assert.equal(subagentMemoryHeadroom(()=> '0::/unrelated.scope\n'),null);
});
test('installer is idempotent and preserves existing hooks and file permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-guard-'));
  try {
    const file = path.join(root, 'hooks.json');
    fs.writeFileSync(file, JSON.stringify({hooks: {Stop: [{hooks: [{type:'command',command:'existing'}]}]}}), {mode: 0o640});
    assert.equal(installSubagentHistoryGuard(root).changed, true);
    assert.equal(installSubagentHistoryGuard(root).changed, false);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.hooks.Stop[0].hooks[0].command, 'existing');
    assert.equal(data.hooks.PreToolUse[0].hooks[0].command, guardCommand);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  } finally { fs.rmSync(root, {recursive: true, force:true}); }
});
