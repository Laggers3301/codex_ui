import {test} from 'node:test';import assert from 'node:assert/strict';
import {buildProcess} from './build-isolation.mjs';
test('agent builds leave the model resource pool but retain hard limits',()=>{
 const p=buildProcess('/node',['vite','build'],'0::/user.slice/codex.slice/codex-workers.slice/codex-agent-100001.scope','test');
 assert.equal(p.command,'/usr/bin/systemd-run');assert.ok(p.args.includes('--slice=app.slice'));assert.ok(p.args.includes('MemoryMax=3G'));assert.ok(p.args.includes('CPUQuota=150%'));assert.deepEqual(p.args.slice(-3),['/node','vite','build']);
});
test('ordinary developer builds remain portable',()=>assert.deepEqual(buildProcess('/node',['vite'],'0::/app.slice'),{command:'/node',args:['vite']}));
