import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {newerVersion,runtimeBinary,selectedRuntime,writeState,selectionFile,adoptValidatedStartupRuntime} from './runtime-update-state.mjs';
test('stable-only upgrade and bounded binary path',()=>{
  assert.equal(newerVersion('0.162.1','0.159.2'),true);
  for(const version of ['0.162.1-alpha','../../bad','0.159.1','0.162.1'])assert.equal(newerVersion(version,'0.162.1'),false);
  assert.throws(()=>runtimeBinary('../wrong'));
});
test('cold start adopts only a validated installed newer stable binary, without touching credentials',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-startup-')),home=path.join(root,'home');fs.mkdirSync(home);
 const candidate=path.join(root,'bin/runtime-candidate.json'),binary=runtimeBinary('0.163.0',root),old=runtimeBinary('0.162.1',root);
 fs.mkdirSync(path.dirname(binary),{recursive:true});fs.mkdirSync(path.dirname(old),{recursive:true});fs.writeFileSync(old,'old',{mode:0o700});
 try{
  writeState(selectionFile(home),{version:'0.162.1'});
  writeState(candidate,{version:'0.163.0',validated:true});
  assert.equal(adoptValidatedStartupRuntime(home,old,root),null);
  fs.writeFileSync(binary,'fixture',{mode:0o700});
  writeState(candidate,{version:'0.163.0',validated:false});
  assert.equal(adoptValidatedStartupRuntime(home,old,root),null);
  writeState(candidate,{version:'0.163.0',validated:true});
  assert.equal(adoptValidatedStartupRuntime(home,old,root),'0.163.0');
  assert.equal(selectedRuntime(home,old,root),binary);
  writeState(candidate,{version:'0.162.1',validated:true});
  assert.equal(adoptValidatedStartupRuntime(home,old,root),null);
  assert.equal(fs.existsSync(path.join(home,'auth.json')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('missing or malformed selection falls back without touching credentials',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-selector-'));
  try {
    assert.equal(selectedRuntime(root,'old',root),'old');
    writeState(selectionFile(root),{version:'../../../bin/sh'});
    assert.equal(selectedRuntime(root,'old',root),'old');
    const binary=runtimeBinary('0.162.1',root);fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,'test',{mode:0o700});
    writeState(selectionFile(root),{version:'0.162.1'});
    assert.equal(selectedRuntime(root,'old',root),binary);
    assert.equal(fs.existsSync(path.join(root,'auth.json')),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
