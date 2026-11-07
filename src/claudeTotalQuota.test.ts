import {expect,it} from 'vitest';
import {claudeFiveHourRemaining} from './claudeTotalQuota';
it('adds only observed, active Claude five-hour remaining quota',()=>{
  const now=1000000,window={kind:'five_hour',percent:27,resetsAt:now+1000,observedAt:now,source:'response' as const};
  const account={orgId:'1',label:'Claude',state:'available' as const,message:'',retryAfterSeconds:null,windows:[window]};
  const status={accounts:[account],thresholdPercent:99,creations:{limit:5,windowSeconds:3600,used:0,remaining:5,retryAt:null,retryAfterSeconds:0},monitoring:'response-events' as const};
  expect(claudeFiveHourRemaining(status,now)).toBe(73);
  expect(claudeFiveHourRemaining({...status,accounts:[{...account,state:'disabled'}]},now)).toBe(0);
  expect(claudeFiveHourRemaining({...status,accounts:[{...account,windows:[{...window,resetsAt:now}]}]},now)).toBe(0);
  expect(claudeFiveHourRemaining({...status,accounts:[{...account,windows:[]}]},now)).toBe(0);
});
