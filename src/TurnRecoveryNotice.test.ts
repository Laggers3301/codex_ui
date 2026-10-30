import {it,expect} from 'vitest';
import {hasRecoveryNotice,historicalRecovery,recoverySourceLabel,recoveryViewportBounds,type TurnRecoveryView} from './TurnRecoveryNotice';
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
it('keeps persisted failures visible until dismissed or replaced by a new turn',()=>{
  const now=Date.now();
  const state:TurnRecoveryView={threadId:'thread',job:null,error:{code:'model_overloaded',message:'繁忙',originalMessage:'capacity',retryable:true,at:new Date(now-3600_000).toISOString()}};
  expect(hasRecoveryNotice(state)).toBe(true);
  state.error!.at=new Date(now).toISOString();expect(hasRecoveryNotice(state)).toBe(true);
  state.job={status:'waiting',attempts:0,maxAttempts:10,nextRetryAt:now+60_000};expect(hasRecoveryNotice(state)).toBe(true);
  expect(hasRecoveryNotice(historicalRecovery('thread',{status:'failed',error:{message:'old error'}}))).toBe(true);
  expect(hasRecoveryNotice({threadId:'thread',job:null,error:null,dismissedTurnId:'turn'})).toBe(false);
});

it('does not label an unexplained interrupted turn as a user stop or invent its time',()=>{
  const state=historicalRecovery('thread',{id:'turn',status:'interrupted'});
  expect(state?.interruption).toMatchObject({turnId:'turn',source:'unknown'});
  expect(state?.error).toMatchObject({code:'turn_interrupted',source:'unknown',at:''});
  expect(recoverySourceLabel(state?.error?.source)).toBe('来源未确认');
  expect(recoverySourceLabel('user')).toBe('主动停止');
  expect(recoverySourceLabel('runtime')).toBe('运行进程退出');
  expect(recoverySourceLabel('backend')).toBe('服务重新启动');
});

it('retains unfinished tool identities and redacts historical credential errors',()=>{
  const state=historicalRecovery('thread',{id:'turn',status:'interrupted',completedAt:1_800_000_000,
    error:{code:'runtime_terminated',message:'app-server exited Bearer private-token'},
    items:[{id:'write',type:'commandExecution',status:'inProgress'},{id:'read',type:'commandExecution',status:'completed'}]});
  expect(state?.interruption?.unresolvedTools).toEqual(['write']);
  expect(state?.error?.source).toBe('runtime');
  expect(state?.error?.at).toBe(new Date(1_800_000_000_000).toISOString());
  expect(JSON.stringify(state)).not.toContain('private-token');
});
