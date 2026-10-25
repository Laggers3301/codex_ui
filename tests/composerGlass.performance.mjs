import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {verifyComposerGlassReadability} from './composerGlassReadability.mjs';
import {verifyTopbarGlass} from './topbarGlassReadability.mjs';
const origin=process.env.QA_GLASS_ORIGIN??'http://127.0.0.1:5216';
assert.ok(['http://127.0.0.1:5216','http://127.0.0.1:4574'].includes(origin),'loopback fixture only');
const evidence=process.env.QA_GLASS_EVIDENCE??'./output/qa/composer-glass-20261025/before';
await fs.mkdir(evidence,{recursive:true});
let cookie;
if(origin.endsWith(':4574')){
  const secret=(await fs.readFile(new URL('../data/auth/session-secret',import.meta.url),'utf8')).trim();
  const payload=Buffer.from(JSON.stringify({u:'qa-user',exp:Date.now()+300000})).toString('base64url');
  cookie=payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
}
const project={id:'glass-project',name:'输入框材质验收',rootPath:'/fixture',userId:'glass-qa',defaultModel:'gpt-6.1-sol',defaultReasoningEffort:'medium',defaultSandbox:'danger-full-access',defaultApprovalPolicy:'never'};
const history=Array.from({length:36},(_,i)=>({id:'old-'+i,status:'completed',items:[
  {id:'u-'+i,type:'userMessage',text:'第 '+i+' 条隔离测试问题'},
  {id:'a-'+i,type:'agentMessage',text:'### 正文与工具渲染\n\n'+('隔离测试回答，不读取或修改任何生产会话。中英混排 reasoning / tool output。').repeat(4)}
]}));
const thread={id:'glass-thread',name:'玻璃材质隔离性能测试',cwd:'/fixture',createdAt:1,updatedAt:1,status:'active',turns:[...history,{id:'glass-turn',status:'running',items:[{id:'glass-user',type:'userMessage',text:'输入、滚动、流式性能验收'}]}]};
const browser=await chromium.launch({headless:true});
const results=[],errors=[];
try{
  const browserCdp=await browser.newBrowserCDPSession();
  const system=await browserCdp.send('SystemInfo.getInfo');
  for(const mobile of [false,true])for(const theme of ['dark','light']){
    if(process.env.QA_GLASS_DEVICE && process.env.QA_GLASS_DEVICE!==(mobile?'phone':'desktop'))continue;
    if(process.env.QA_GLASS_THEME && process.env.QA_GLASS_THEME!==theme)continue;
    const page=await browser.newPage({viewport:mobile?{width:393,height:852}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});
    page.on('pageerror',error=>errors.push(error.message));
    if(cookie)await page.context().addCookies([{name:'codex_remote_session_4575',value:cookie,url:origin,httpOnly:true,sameSite:'Lax'}]);
    await page.addInitScript(({height})=>{
      localStorage.setItem('codex-web-user-id','glass-qa');localStorage.setItem('codex-v2-project-glass-qa','glass-project');
      localStorage.setItem('codex-v2-expanded-projects-glass-qa','["glass-project"]');localStorage.setItem('codex-web-composer-height',height);
      class Socket extends EventTarget{
        static OPEN=1;static CONNECTING=0;static CLOSED=3;readyState=0;text='';agentId=0;
        constructor(){super();window.glassSocket=this;setTimeout(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));this.emit({type:'hello',data:{liveState:this.snapshot(),turnProgress:[],pendingServerRequests:[]}});},20);}
        snapshot(){return{activeTurns:[{threadId:'glass-thread',turnId:'glass-turn',status:'running',startedAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z'}],agentMessages:[],reasoningMessages:[],toolItems:[]};}
        emit(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}
        send(raw){const value=JSON.parse(raw);if(value.type==='transport.ping')this.emit({type:'transport.pong'});else if(value.type==='live.state')this.emit({type:'live.state',data:this.snapshot()});else if(value.requestId)this.emit({type:'ack',requestId:value.requestId,ok:true,data:{data:[]}});}
        begin(){this.agentId++;this.text='';}
        chunk(delta){const offset=this.text.length;this.text+=delta;this.emit({type:'live.agent.delta',data:{itemId:'glass-stream-'+this.agentId,threadId:'glass-thread',turnId:'glass-turn',delta,textOffset:offset,startedAt:new Date().toISOString(),streamState:'streaming',completed:false}});}
        close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
      }window.WebSocket=Socket;
    },{height:process.env.QA_GLASS_HEIGHT??'90'});
    let interceptedMutations=0;
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url()),p=url.pathname;
      if(!['GET','HEAD'].includes(route.request().method()))interceptedMutations++;
      let json={data:[]};
      if(p==='/api/users')json={data:[{id:'glass-qa',name:'glass-qa'}],defaultUserId:'glass-qa'};
      else if(p==='/api/projects')json={data:[project],projectRoot:'/fixture'};
      else if(p==='/api/projects/glass-project/threads')json={data:[thread]};
      else if(p==='/api/threads/glass-thread')json={thread,history:{totalItems:73,returnedItems:73,before:0,hasOlder:false}};
      else if(p.endsWith('/execution-settings'))json={data:{sandbox:'danger-full-access',approvalPolicy:'never'}};
      else if(p.endsWith('/context')||p.endsWith('/side-chat'))json={data:null};
      else if(p.endsWith('/subagents'))json={data:[],page:{total:0,activeCount:0,historyCount:0,hasMore:false}};
      else if(p==='/api/pets')json={pets:[],activePetId:null,visible:false,position:null};
      else if(p==='/api/codex/account-pool')json={data:{accounts:[],currentThreadAccountId:null}};
      else if(p==='/api/codex/provider-quotas')json={data:{items:[],loading:false}};
      else if(p==='/api/models')json={data:[{id:'fixture-model',label:'GPT-6.1-Sol medium',model:'gpt-6.1-sol',effort:'medium'}]};
      await route.fulfill({json});
    });
    await page.goto(origin+'/?project=glass-project&thread=glass-thread');
    await page.getByText('输入、滚动、流式性能验收',{exact:true}).waitFor();
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const editor=page.locator('.conversation > .composer .composerRichInput');
    await editor.fill('准备输入，检查材质和控件的可读性。');
    await page.waitForTimeout(1400);
    if(process.env.QA_GLASS_EXPERIMENT==='single'){
      await page.evaluate(()=>{
        let count=0;
        for(const host of document.querySelectorAll('.composerLiquidGlass,.topbarGlassControl')){
          const native=host.querySelector('filter');if(!native)continue;
          const simple=document.createElementNS('http://www.w3.org/2000/svg','filter');simple.id='qa-single-displacement-'+count++;
          for(const key of ['x','y','width','height','color-interpolation-filters'])if(native.hasAttribute(key))simple.setAttribute(key,native.getAttribute(key));
          simple.append(native.querySelector('feImage').cloneNode(true),native.querySelector('feDisplacementMap').cloneNode(true));
          native.parentNode.append(simple);
          const topbar=host.classList.contains('topbarGlassControl');
          host.style.setProperty(topbar?'--topbar-backdrop-optics':'--composer-backdrop-optics','url("#'+simple.id+'") blur('+(topbar?8:12)+'px) saturate(1.12)');
          host.dataset.glassExperiment='single-displacement';
        }
      });
    }
    if(process.env.QA_GLASS_EXPERIMENT==='relocate')await page.evaluate(()=>{
      for(const host of document.querySelectorAll('.composerLiquidGlass,.topbarGlassControl')){
        const value=host.style.getPropertyValue(host.classList.contains('topbarGlassControl')?'--topbar-backdrop-optics':'--composer-backdrop-optics');
        const id=value.match(/#([^"\)]+)/)?.[1],active=id?document.getElementById(id):null;
        const native=host.querySelector('.composerOriginalPane filter,.topbarOriginalPane filter');
        if(active&&native&&active!==native)native.parentNode.append(active);
      }
    });
    if(process.env.QA_GLASS_CLIP==='1'){
      await page.locator('.composerOriginalPane filter').evaluateAll(filters=>filters.forEach(filter=>{filter.setAttribute('x','0%');filter.setAttribute('y','0%');filter.setAttribute('width','100%');filter.setAttribute('height','100%');}));
    }
    const plusBounds=await page.evaluate(()=>{const tools=document.querySelector('.composerControlRow .composerTools').getBoundingClientRect(),plus=document.querySelector('.composerControlRow .v2ComposerPlus').getBoundingClientRect();return{toolsLeft:tools.left,plusLeft:plus.left};});
    assert.ok(Math.abs(plusBounds.toolsLeft-plusBounds.plusLeft)<2,'plus remains at the left edge of the controls');
    if(process.env.QA_TOPBAR_ONLY==='1'){
      const verification=await verifyTopbarGlass(page,evidence,(mobile?'phone':'desktop')+'-'+theme);
      results.push({mobile,theme,verification,productionWrites:0});await page.close();continue;
    }
    if(process.env.QA_GLASS_READABILITY_ONLY==='1'){
      const verification=await verifyComposerGlassReadability(page,evidence,(mobile?'phone':'desktop')+'-'+theme);
      results.push({mobile,theme,verification,productionWrites:0});await page.close();continue;
    }
    const state=await page.evaluate(()=>{
      const root=document.querySelector('.conversation > .composer'),rim=root.querySelector('.composerLiquidRim'),layer=root.querySelector('.composerOriginalLayer');
      const trigger=root.querySelector('.groupedModelPicker > button');
      const backingFilter=getComputedStyle(root,'::before').backdropFilter,filterId=backingFilter.match(/#([^"\)]+)/)?.[1];
      return{dataset:{...root.dataset},activeFilterPrimitives:filterId?document.getElementById(filterId)?.children.length:0,originalLayers:root.querySelectorAll('.composerOriginalLayer').length,rimReady:rim?.dataset.lensReady,backingFilter,
        nativeWarp:layer?.querySelector('.glass__warp')?{filter:getComputedStyle(layer.querySelector('.glass__warp')).filter,backdrop:getComputedStyle(layer.querySelector('.glass__warp')).backdropFilter}:null,
        trigger:{color:getComputedStyle(trigger).color,background:getComputedStyle(trigger).backgroundImage,border:getComputedStyle(trigger).border,shadow:getComputedStyle(trigger).boxShadow},
        inputFilter:getComputedStyle(root.querySelector('.composerRichInput')).filter};
    });
    await page.screenshot({path:evidence+'/'+(mobile?'phone':'desktop')+'-'+theme+'-page.png'});
    await page.locator('.conversation > .composer').screenshot({path:evidence+'/'+(mobile?'phone':'desktop')+'-'+theme+'-composer.png'});
    const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
    const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    const runs=[];
    for(const workload of (process.env.QA_GLASS_SCROLL_ONLY==='1'?['scroll']:['typing','scroll','stream']))for(let repeat=0;repeat<2;repeat++){
      if(workload==='typing'){await editor.fill('');await editor.focus();}
      await page.evaluate(()=>getSelection()?.removeAllRanges());
      const before=await metrics();
      const recording=page.evaluate(async workload=>{
        const frames=[],longTasks=[];let previous=0,start=0,timer;
        const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(e=>e.duration)));
        observer.observe({type:'longtask',buffered:false});
        const scroller=document.querySelector('.messages');
        let scrollUsable=false,scrollEvents=0,chunks=0;
        const onScroll=()=>scrollEvents++;
        if(workload==='scroll'){
          scrollUsable=!!scroller&&scroller.scrollHeight>scroller.clientHeight+50;
          scroller?.addEventListener('scroll',onScroll,{passive:true});
          timer=setInterval(()=>{if(scroller){const max=scroller.scrollHeight-scroller.clientHeight;scroller.scrollTop=Math.max(0,Math.min(max,max*(.5+.45*Math.sin(performance.now()/250))));}},40);
        }
        if(workload==='stream'){window.glassSocket.begin();timer=setInterval(()=>{chunks++;window.glassSocket.chunk('流式回答增量 Streamed answer，保持现有正文与工具界面。 ');},50);}
        await new Promise(resolve=>{const tick=now=>{start||=now;if(previous)frames.push(now-previous);previous=now;if(now-start<1800)requestAnimationFrame(tick);else resolve();};requestAnimationFrame(tick);});
        clearInterval(timer);scroller?.removeEventListener('scroll',onScroll);observer.disconnect();frames.sort((a,b)=>a-b);
        return{fps:frames.length*1000/(previous-start),p95Ms:frames[Math.floor(frames.length*.95)],framesOver33ms:frames.filter(x=>x>33).length,longTasks:longTasks.length,longTaskMs:longTasks.reduce((a,b)=>a+b,0),scrollUsable,scrollEvents,chunks,dataset:{...document.querySelector('.conversation > .composer').dataset}};
      },workload);
      let inputMs=null;
      if(workload==='typing'){const t=performance.now();await editor.pressSequentially('这是一段中英混排的输入测试，typing should remain responsive。',{delay:22});inputMs=performance.now()-t;}
      const measured=await recording,after=await metrics();
      if(workload==='scroll')assert.ok(measured.scrollUsable&&measured.scrollEvents>0,'actual fixture scroll viewport moves');
      if(workload==='stream')assert.ok(measured.chunks>0,'delta events were actually delivered; low delivery count remains a measured slowdown, not a discarded sample');
      runs.push({workload,repeat,inputMs,...measured,rendererTaskMs:(after.TaskDuration-before.TaskDuration)*1000,heapMiB:after.JSHeapUsedSize/1048576});
    }
    const pointer=await page.evaluate(()=>{
      const root=document.querySelector('.conversation > .composer'),box=root.getBoundingClientRect(),pane=root.querySelector('.composerOriginalPane');
      const before=pane?getComputedStyle(pane).transform:root.style.getPropertyValue('--composer-light-x');
      root.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:box.right-12,clientY:box.top+12}));
      root.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:box.right-12,clientY:box.top+12}));
      return{before};
    });
    await page.waitForTimeout(350);
    pointer.after=await page.evaluate(()=>{const root=document.querySelector('.conversation > .composer'),pane=root.querySelector('.composerOriginalPane');return pane?getComputedStyle(pane).transform:root.style.getPropertyValue('--composer-light-x');});
    const row={mobile,theme,state,pointer,runs,interceptedMutations,productionWrites:0};results.push(row);console.log(JSON.stringify(row));
    await page.close();
  }
  assert.deepEqual(errors,[]);
  const result={at:new Date().toISOString(),origin,gpu:system.gpu.devices.map(d=>({vendor:d.vendorString,device:d.deviceString})),results,errors,limits:['Isolated API/WebSocket fixtures; no production model requests or conversation writes.','Chromium mobile viewport/touch emulation, not a physical iPhone/Safari.','Two short samples per workload; renderer task time excludes GPU/compositor work.']};
  await fs.writeFile(evidence+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify({finished:true,errors}));
}finally{await browser.close();}
