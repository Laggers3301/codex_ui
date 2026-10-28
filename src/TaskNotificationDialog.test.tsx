// @vitest-environment jsdom
import React,{act} from 'react';import{createRoot}from'react-dom/client';import{expect,it,vi}from'vitest';
import{TaskNotificationDialog,type TaskNotificationDialogProps}from'./TaskNotificationDialog';
it('retains accessible labels, lock-screen consequences and independent toggle/test actions',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 const props:TaskNotificationDialogProps={enabled:false,busy:false,ready:true,canTest:true,onToggle:vi.fn(),onTest:vi.fn(),onClose:vi.fn()};
 try{
  await act(async()=>root.render(<TaskNotificationDialog {...props}/>));
  const dialog=document.querySelector('[role="dialog"]')!;
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('任务通知');
  expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('锁屏可见');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭任务通知');
  const toggle=dialog.querySelector<HTMLButtonElement>('[role="switch"]')!;expect(toggle.getAttribute('aria-checked')).toBe('false');toggle.click();expect(props.onToggle).toHaveBeenCalledTimes(1);
  const test=dialog.querySelector<HTMLButtonElement>('.taskNotificationTest')!;expect(test.disabled).toBe(true);test.click();expect(props.onTest).not.toHaveBeenCalled();
  await act(async()=>root.render(<TaskNotificationDialog {...props} enabled status="推送已提交"/>));
  expect(toggle.getAttribute('aria-checked')).toBe('true');expect(test.disabled).toBe(false);test.click();expect(props.onTest).toHaveBeenCalledTimes(1);
  expect(dialog.querySelector('[role="status"]')?.textContent).toBe('推送已提交');
  await act(async()=>root.render(<TaskNotificationDialog {...props} error="浏览器未授权"/>));expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('浏览器未授权');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));expect(props.onClose).toHaveBeenCalledTimes(1);
  await act(async()=>root.render(<TaskNotificationDialog {...props} closing/>));expect(document.querySelector('.taskNotificationScrim')?.hasAttribute('inert')).toBe(true);
 }finally{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();}
});
it('returns keyboard focus to the account button when the closed menu has already blurred to body',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const trigger=document.createElement('button');trigger.className='v2AccountTrigger';document.body.append(trigger);
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 try{
  await act(async()=>root.render(<TaskNotificationDialog enabled={false} busy={false} ready canTest={false} onToggle={()=>{}} onTest={()=>{}} onClose={()=>{}}/>));
  await act(async()=>root.unmount());expect(document.activeElement).toBe(trigger);
 }finally{trigger.remove();container.remove();vi.unstubAllGlobals();}
});
