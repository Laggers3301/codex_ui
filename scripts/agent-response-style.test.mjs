import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {responseStyleInstructions,responseLanguageInstructions,ensureClaudeResponseStyle} from './agent-response-style.mjs';
import {ensureDelegationPolicy} from './agent-delegation-policy.mjs';

test('Claude native instructions preserve existing text, mode and credentials; repeated install is stable',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'response-style-'));
 try{
  fs.writeFileSync(path.join(home,'CLAUDE.md'),'# Existing instructions\n\nKeep project rules.\n',{mode:0o640});
  fs.writeFileSync(path.join(home,'auth.json'),'fixture');
  assert.equal(ensureClaudeResponseStyle(home),true);
  const text=fs.readFileSync(path.join(home,'CLAUDE.md'),'utf8');
  assert(text.includes(responseStyleInstructions));assert(text.endsWith('# Existing instructions\n\nKeep project rules.\n'));
  assert(text.includes(responseLanguageInstructions));
  assert.equal(ensureClaudeResponseStyle(home),false);assert.equal(fs.statSync(path.join(home,'CLAUDE.md')).mode&0o777,0o640);
  assert.equal(fs.readFileSync(path.join(home,'auth.json'),'utf8'),'fixture');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('launcher repairs style even when old language/delegation rules are already present',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'response-launch-'));
 try{
  const file=path.join(home,'AGENTS.override.md');
  fs.writeFileSync(file,'<!-- codex-web:response-language:start -->\nExisting rules\n<!-- codex-web:response-language:end -->\nUSER RULES');
  ensureDelegationPolicy(home);const text=fs.readFileSync(file,'utf8');
  assert(text.includes(responseStyleInstructions));assert(text.endsWith('USER RULES'));
  assert.equal(ensureDelegationPolicy(home),'unchanged');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('style is a chat default with independent parent summaries, not a forced document format or hidden certainty',()=>{
 for(const text of ['父项本身概括','必要时三层','代码、命令、日志、论文、邮件','用户明确要求其他格式','未核实的事实','子代理'])assert(responseStyleInstructions.includes(text));
});
