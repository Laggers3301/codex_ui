import test from 'node:test';import assert from 'node:assert/strict';
import {renewalEvidence} from './verify-ark-renewal.mjs';
const baseline={issuedAt:'2026-10-26T04:03:36Z',expiresAt:'2026-10-26T04:18:36Z'};
const quota={status:'ready',stale:false,updatedAt:'2026-10-26T04:19:00Z'};
const next={issuedAt:'2026-10-26T04:17:00Z',expiresAt:'2026-10-26T04:32:00Z'};
test('fresh quota by itself never proves native renewal',()=>assert.equal(renewalEvidence(baseline,baseline,quota,Date.parse('2026-10-26T04:19:10Z')),'waiting_for_native_renewal'));
test('date advancement before original expiry is not the complete cross-expiry check',()=>assert.equal(renewalEvidence(baseline,next,quota,Date.parse('2026-10-26T04:18:00Z')),'dates_advanced_waiting_for_old_expiry'));
test('requires advanced native dates and a real post-expiry successful query',()=>{
 assert.equal(renewalEvidence(baseline,next,quota,Date.parse('2026-10-26T04:19:10Z')),'verified');
 for(const q of [{...quota,stale:true},{...quota,status:'auth_required'},{...quota,updatedAt:'2026-10-26T04:17:00Z'}])assert.notEqual(renewalEvidence(baseline,next,q,Date.parse('2026-10-26T04:19:10Z')),'verified');
});
test('rejects expired or invalid metadata and future-issued dates',()=>{
 assert.equal(renewalEvidence(baseline,{...next,expiresAt:'bad'},quota),'invalid_metadata');
 assert.notEqual(renewalEvidence(baseline,{issuedAt:'2026-10-26T05:00:00Z',expiresAt:'2026-10-26T05:15:00Z'},quota,Date.parse('2026-10-26T04:19:10Z')),'verified');
});
