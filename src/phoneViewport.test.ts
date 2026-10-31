// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
afterEach(()=>{document.body.replaceChildren();for(const e of [document.documentElement,document.body])for(const n of ['--phone-viewport-height','height','max-height'])e.style.removeProperty(n);vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
async function setup(local=true){
 vi.resetModules();vi.useFakeTimers();const viewport=new EventTarget() as EventTarget&{height:number};viewport.height=800;
 vi.stubGlobal('visualViewport',viewport);const media=Object.assign(new EventTarget(),{matches:true});vi.stubGlobal('matchMedia',()=>media);
 vi.stubGlobal('CSS',{registerProperty:local?vi.fn():()=>{throw Error('unsupported');}});
 vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>setTimeout(()=>cb(0),16));vi.stubGlobal('cancelAnimationFrame',clearTimeout);
 document.body.innerHTML='<div id="root"><div class="composer"><div class="composerBody"><div class="composerRichEditor"></div></div></div><p>ordinary transcript</p></div>';
 const {observePhoneViewport}=await import('./phoneViewport');const stop=observePhoneViewport();return{viewport,media,stop};
}
it('scopes keyboard viewport length to consumers, deduplicates events and supports new popovers',async()=>{
 const f=await setup();expect(CSS.registerProperty).toHaveBeenCalledWith(expect.objectContaining({inherits:false,initialValue:`${Math.round(innerHeight)}px`}));
 expect(document.querySelector<HTMLElement>('.composer')!.style.getPropertyValue('--phone-viewport-height')).toBe('800px');expect(document.querySelector('p')!.getAttribute('style')).toBeNull();
 const set=vi.spyOn(CSSStyleDeclaration.prototype,'setProperty');f.viewport.dispatchEvent(new Event('resize'));f.viewport.dispatchEvent(new Event('scroll'));await vi.advanceTimersByTimeAsync(20);expect(set).not.toHaveBeenCalled();
 f.viewport.height=500;f.viewport.dispatchEvent(new Event('resize'));await vi.advanceTimersByTimeAsync(20);expect(document.body.style.getPropertyValue('--phone-viewport-height')).toBe('');expect(document.body.style.getPropertyValue('height')).toBe('500px');
 const menu=document.createElement('div');menu.className='v2AccountMenu';document.body.append(menu);await Promise.resolve();expect(menu.style.getPropertyValue('--phone-viewport-height')).toBe('500px');
 f.media.matches=false;f.media.dispatchEvent(new Event('change'));await vi.advanceTimersByTimeAsync(20);expect(menu.style.getPropertyValue('--phone-viewport-height')).toBe(`${Math.round(innerHeight)}px`);f.stop();
});
it('keeps the inherited fallback if property registration is unavailable',async()=>{
 const f=await setup(false);expect(document.documentElement.style.getPropertyValue('--phone-viewport-height')).toBe('800px');expect(document.querySelector<HTMLElement>('.composer')!.style.getPropertyValue('--phone-viewport-height')).toBe('');f.stop();
});
