// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
const {frame}=vi.hoisted(()=>({frame:vi.fn()}));
vi.mock('@paper-design/shaders',()=>({getShaderColorFromString:(v:string)=>v,meshGradientFragmentShader:'fixture',ShaderMount:class{
  canvasElement=document.createElement('canvas'); setFrame=frame;setUniforms=vi.fn();dispose=vi.fn();
}}));
import {mountPaperAmbient} from './paperAmbient';
it('freezes decorative GPU draws while scrolling and resumes without a time jump',()=>{
 let next:FrameRequestCallback|undefined;
 vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{next=cb;return 1;});
 vi.stubGlobal('cancelAnimationFrame',()=>{next=undefined;});
 const canvas=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
 const renderer=mountPaperAmbient(document.createElement('div'),'dark');
 const step=(now:number)=>{const cb=next;next=undefined;cb?.(now);};
 try{
  renderer.setRunning(true);const start=performance.now();step(start+50);expect(frame).toHaveBeenCalledTimes(1);
  document.documentElement.setAttribute('data-glass-scrolling','');
  step(start+100);step(start+150);step(start+1000);expect(frame).toHaveBeenCalledTimes(1);
  document.documentElement.removeAttribute('data-glass-scrolling');
  step(start+1050);expect(frame).toHaveBeenCalledTimes(2);
  expect(frame.mock.calls[1][0]-frame.mock.calls[0][0]).toBeLessThan(100);
 }finally{renderer.dispose();document.documentElement.removeAttribute('data-glass-scrolling');canvas.mockRestore();frame.mockReset();vi.unstubAllGlobals();}
});
