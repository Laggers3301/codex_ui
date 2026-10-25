import {it,expect} from 'vitest';
import {isFreshRecoveryNotice,historicalRecovery,recoveryViewportBounds,type TurnRecoveryView} from './TurnRecoveryNotice';
it('renders nested native failures and old object-coercion errors as readable HTTP errors',()=>{
 const state=historicalRecovery('thread',{status:'failed',error:{code:'[object Object]',message:'本轮处理失败',originalMessage:'exceeded retry limit, last status: 429 Too Many Requests'}});
 expect(state?.error?.code).toBe('http_429');
 expect(state?.error?.originalMessage).toContain('429');
 expect(historicalRecovery('thread',{status:'failed',error:{message:{error:{message:'HTTP 429',code:'AccountQuotaExceeded'}}}})?.error?.code).toBe('AccountQuotaExceeded');
});
it('centers in the whole viewport regardless of sidebar and right-pane widths',()=>{
 expect(recoveryViewportBounds(1280,850)).toEqual({left:0,top:0,width:1280,height:850});
});
it('follows the visible mobile viewport when the keyboard or pinch pan changes it',()=>{
 expect(recoveryViewportBounds(390,850,{offsetLeft:5,offsetTop:24,width:380,height:430})).toEqual({left:5,top:24,width:380,height:430});
});
it('does not repopulate old persisted failures but shows fresh failures and active retries',()=>{
  const now=Date.now();
  const state:TurnRecoveryView={threadId:'thread',job:null,error:{code:'model_overloaded',message:'繁忙',originalMessage:'capacity',retryable:true,at:new Date(now-3600_000).toISOString()}};
  expect(isFreshRecoveryNotice(state,now)).toBe(false);
  state.error!.at=new Date(now).toISOString();expect(isFreshRecoveryNotice(state,now)).toBe(true);
  state.job={status:'waiting',attempts:0,maxAttempts:10,nextRetryAt:now+60_000};expect(isFreshRecoveryNotice(state,now)).toBe(true);
  expect(isFreshRecoveryNotice(historicalRecovery('thread',{status:'failed',error:{message:'old error'}}),now)).toBe(false);
});
