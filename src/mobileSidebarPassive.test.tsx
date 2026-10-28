// @vitest-environment jsdom
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {useMobileSidebar} from './useMobileSidebar';
it('keeps both drawer touchmove listeners passive so vertical scrolling need not wait for JS',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const spy=vi.spyOn(EventTarget.prototype,'addEventListener');
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 function Fixture(){useMobileSidebar(true,()=>{});useMobileSidebar(true,()=>{},'right');return <section className="threadColumn"/>;}
 try{
  await act(async()=>root.render(<Fixture/>));
  const listeners=spy.mock.calls.map((call,index)=>({call,target:spy.mock.contexts[index]})).filter(({call,target})=>call[0]==='touchmove'&&target===container.querySelector('.threadColumn'));
  expect(listeners).toHaveLength(2);
  for(const {call}of listeners)expect(call[2]).toEqual({passive:true,capture:true});
 }finally{await act(async()=>root.unmount());container.remove();spy.mockRestore();vi.unstubAllGlobals();}
});
