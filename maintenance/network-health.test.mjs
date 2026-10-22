import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NetworkRecoveryPolicy,edgeCount,confirmedEdgeCount,recoveryFailureReason} from './network-health.mjs';
const healthy={backendStatus:401,backendWS:true,frontendStatus:200,frontendWS:true,mainConnections:4,quicConnections:null};
test('active connection attempts cannot hide a disconnected connector',()=>{
 const metrics={status:200,text:'cloudflared_tunnel_ha_connections 4\n'};
 assert.equal(confirmedEdgeCount(metrics,{status:503}),0);
 assert.equal(confirmedEdgeCount(metrics,{status:200}),4);
 assert.equal(confirmedEdgeCount(metrics,{status:0}),null);
 assert.equal(confirmedEdgeCount({status:0},{status:200}),1);
});
test('restart timeout is not misreported as a permission failure',()=>{
 assert.equal(recoveryFailureReason('restart-tunnel',{killed:true}),'restart-timeout');
 assert.equal(recoveryFailureReason('restart-tunnel',{stderr:'Job failed because a timeout was exceeded.'}),'restart-timeout');
 assert.equal(recoveryFailureReason('restart-tunnel',{stderr:'sudo: a password is required'}),'administrator-permission-required');
 assert.equal(recoveryFailureReason('restart-tunnel',{stderr:'Job failed with exit-code'}),'restart-failed');
});
test('absent secondary connector is not a tunnel failure',()=>{assert.equal(edgeCount({status:0,text:''}),null);const p=new NetworkRecoveryPolicy();for(let i=0;i<10;i++)assert.equal(p.evaluate(healthy,i*15000),null);});
test('only confirmed complete tunnel outage restarts, not partial or unknown metrics',()=>{const p=new NetworkRecoveryPolicy();for(const mainConnections of [null,3,4])assert.equal(p.evaluate({...healthy,mainConnections},0),null);const broken={...healthy,mainConnections:0};assert.equal(p.evaluate(broken,15000),null);assert.equal(p.evaluate(broken,30000),null);assert.equal(p.evaluate(broken,45000),'restart-tunnel');assert.equal(p.evaluate(broken,60000),null);});
test('never restarts tunnel while the origin is failing',()=>{const p=new NetworkRecoveryPolicy();for(let i=0;i<10;i++)assert.equal(p.evaluate({...healthy,backendWS:false,mainConnections:0},i*15000),null);});
test('healthy company relay suppresses restarts of the unused local connector',()=>{const p=new NetworkRecoveryPolicy();for(let i=0;i<10;i++)assert.equal(p.evaluate({...healthy,mainConnections:0,cloudRelay:{ready:200,origin:200}},i*15000),null);});
test('company ingress failures recover only their own transport',()=>{
 for(const [cloudRelay,kind] of [[{ready:0,origin:0},'restart-ssh-relay'],[{ready:503,origin:200},'restart-cloud-tunnel']]){
  const p=new NetworkRecoveryPolicy(),s={...healthy,mainConnections:0,cloudRelay};
  assert.equal(p.evaluate(s,0),null);assert.equal(p.evaluate(s,15000),null);assert.equal(p.evaluate(s,30000),kind);
 }
});
test('proxy recovery is separate, requires healthy backend and three failed checks',()=>{const p=new NetworkRecoveryPolicy(),broken={...healthy,frontendWS:false};assert.equal(p.evaluate(broken,0),null);assert.equal(p.evaluate(broken,15000),null);assert.equal(p.evaluate(broken,30000),'restart-frontend');assert.equal(p.evaluate(broken,45000),null);});
test('unreachable diagnostics or congested LAN never tear down a forwarding session',()=>{
 for(const extra of [
  {cloudRelay:{ready:0,origin:0,reachable:false}},
  {cloudRelay:{ready:200,origin:0},network:{gateway:{ok:true,ms:304}}},
  {cloudRelay:{ready:0,origin:0},network:{gateway:{ok:false}}}
 ]){
  const p=new NetworkRecoveryPolicy();
  for(let i=0;i<60;i++)assert.equal(p.evaluate({...healthy,...extra},i*15000),null);
 }
});
