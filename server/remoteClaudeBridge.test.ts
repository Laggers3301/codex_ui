import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {expect,it} from 'vitest';

it('keeps remote validation fail-closed and does not follow redirects',()=>{
  const script=String.raw`
import importlib.util,json,base64,tempfile,pathlib,types
spec=importlib.util.spec_from_file_location('bridge', ${JSON.stringify(path.resolve(__dirname, '../scripts/remote-claude-bridge.py'))})
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
scope={'userId':'qa-user','sourceThreadId':'source','allowedModels':['claude-opus-fixture']}
row={'userId':'qa-user','sourceThreadId':'source','method':'POST','path':'/v1/messages','body':base64.b64encode(json.dumps({'model':'claude-opus-fixture'}).encode()).decode(),'headers':{}}
assert b.validate_request(scope,row)
for changes in [{'userId':'other'},{'sourceThreadId':'other'},{'path':'/admin/login'},{'headers':{'accept':'x\ny'}},{'body':base64.b64encode(b'{"model":"claude-sonnet-fixture"}').decode()}]:
 try:b.validate_request(scope,{**row,**changes})
 except ValueError:pass
 else:raise AssertionError('unauthorized request accepted')
assert b.NoRedirect().redirect_request(None,None,302,'',{},'https://attacker.invalid') is None
with tempfile.TemporaryDirectory() as tmp:
 b.__file__=str(pathlib.Path(tmp)/'bridge.py')
 started=[]
 def fake_start(args,**kwargs):
  assert 'SSH_ORIGINAL_COMMAND' not in kwargs['env']
  folder=b.job_root(args[-1]);(folder/'events.jsonl').write_text(json.dumps({'seq':1,'type':'end'})+'\n');(folder/'done').touch()
  started.append(args);return types.SimpleNamespace(pid=123456789)
 b.subprocess.Popen=fake_start
 request={**row,'id':'a'*64,'cursor':0}
 b.relay(scope,request);b.relay(scope,{**request,'cursor':1});assert len(started)==1
 try:b.relay(scope,{**request,'headers':{'accept':'different'}})
 except ValueError:pass
 else:raise AssertionError('conflicting request replayed')
print('PASS')
`;
  const result=execFileSync('/usr/bin/python3',['-c',script],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  expect(result.trim().endsWith('PASS')).toBe(true);
});
