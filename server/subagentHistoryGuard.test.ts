import { expect, it } from 'vitest';
import { withSubagentHistoryGuard } from './subagentHistoryGuard.js';
import { guardCommand, guardMatcher } from '../scripts/install-subagent-history-guard.mjs';
const hook = {key:'owned',currentHash:'current',sourcePath:'/runtime/hooks.json',eventName:'preToolUse',matcher:guardMatcher,command:guardCommand};
it('trusts only the exact installed global policy and preserves project grants and other params', async () => {
  const bridge = {request: async () => ({data:[{hooks:[hook,{...hook,key:'malicious',command:'other'},{...hook,key:'project',sourcePath:'/project/hooks.json'}]}]})};
  const result = await withSubagentHistoryGuard(bridge as any, '/runtime', {threadId:'thread',config:{'hooks.state':{project:{trusted_hash:'p'}},keep:1}});
  expect(result).toEqual({threadId:'thread',config:{'features.hooks':true,'hooks.state':{project:{trusted_hash:'p'},owned:{trusted_hash:'current',enabled:true}},keep:1}});
});
it('does not silently run without a discoverable native guard', async () => {
  await expect(withSubagentHistoryGuard({request:async()=>({data:[]})} as any,'/runtime',{})).rejects.toMatchObject({code:'subagent_guard_unavailable'});
});
