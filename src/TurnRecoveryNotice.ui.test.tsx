// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnRecoveryNotice, type TurnRecoveryView } from './TurnRecoveryNotice';
afterEach(() => vi.unstubAllGlobals());
it('shows a neutral user-stop status without error details, model switching or auto retry controls', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const node=document.createElement('div'),stack=document.createElement('div');stack.className='threadNoticeStack';document.body.append(stack);
  const root=createRoot(node),onAction=vi.fn();
  const state:TurnRecoveryView={threadId:'manual-stop-test',job:null,error:{code:'user_stopped',source:'user',message:'已停止',originalMessage:'user stop',retryable:false,at:''},interruption:{turnId:'turn',source:'user',unresolvedTools:[]}};
  try {
    await act(()=>root.render(<TurnRecoveryNotice state={state} userId="alice" onSelectModel={vi.fn()} onAction={onAction} />));
    expect(stack.querySelector('[role=status]')).not.toBeNull();expect(stack.textContent).toContain('已停止本轮回答');
    expect(stack.querySelector('.errorBanner,[role=alert],details')).toBeNull();
    expect(stack.textContent).not.toMatch(/错误|切换模型|自动重试|沿用任务继续/);
    await act(()=>root.render(<TurnRecoveryNotice state={{...state,interruption:{...state.interruption!,unresolvedTools:['write']}}} userId="alice" onAction={onAction} />));
    expect(stack.textContent).toContain('部分工具结果尚未确认');
    await act(()=>stack.querySelector<HTMLButtonElement>('button:not(.iconButton)')!.click());
    expect(onAction).toHaveBeenCalledWith('check');
    expect(onAction).not.toHaveBeenCalledWith('continue');
  } finally { await act(()=>root.unmount());stack.remove(); }
});
