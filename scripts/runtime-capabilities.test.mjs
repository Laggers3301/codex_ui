import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCapabilities} from './runtime-capabilities.mjs';
test('detects additions/removals and does not confuse requests with disk compression',()=>{
  const result=inspectCapabilities('1.2.3','{"method": "thread/read"}|{"method": "rollout/compress"}',
    'enable_request_compression stable true\nlocal_thread_store_compression under development false',
    {methods:['thread/read','obsolete']});
  assert.deepEqual(result.addedMethods,['rollout/compress']);assert.deepEqual(result.removedMethods,['obsolete']);
  assert.equal(result.storage.nativeCompression,true);assert.equal(result.features[1].enabled,false);
  assert.equal(result.features[1].stage,'under development');assert.equal(result.autoRewriteProductionCode,false);
});
