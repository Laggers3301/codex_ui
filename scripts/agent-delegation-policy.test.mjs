import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { delegationContextInstructions, ensureDelegationPolicy } from './agent-delegation-policy.mjs';
test('repairs an older managed block idempotently without touching user instructions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-policy-'));
  try {
    const file = path.join(root, 'AGENTS.md');
    const original = '<!-- codex-web:response-language:start -->\nOriginal language rules\n<!-- codex-web:response-language:end -->\n\nUSER INSTRUCTIONS\n';
    fs.writeFileSync(file, original, {mode: 0o640});
    assert.equal(ensureDelegationPolicy(root), 'installed');
    const next = fs.readFileSync(file, 'utf8');
    assert(next.includes(delegationContextInstructions));
    assert(next.endsWith('\n\nUSER INSTRUCTIONS\n'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.equal(ensureDelegationPolicy(root), 'unchanged');
    fs.writeFileSync(file, 'No managed block');
    assert.equal(ensureDelegationPolicy(root), 'missing_managed_block');
    assert.equal(fs.readFileSync(file, 'utf8'), 'No managed block');
    fs.unlinkSync(file); fs.symlinkSync(path.join(root, 'target.md'), file);
    assert.throws(() => ensureDelegationPolicy(root), /Invalid managed/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
