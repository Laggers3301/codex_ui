import assert from 'node:assert/strict';
import {createCanvas,loadImage} from '@napi-rs/canvas';

async function pixels(buffer){const image=await loadImage(buffer),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return{width:image.width,height:image.height,data:ctx.getImageData(0,0,image.width,image.height).data};}

export async function verifyTopbarGlass(page,evidence,label){
  const controls=page.locator('.topbar button.topbarGlassControl');
  const initial=await controls.evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width>0).map(node=>{
    const box=node.getBoundingClientRect(),pane=node.querySelector('.topbarOriginalPane').getBoundingClientRect(),style=getComputedStyle(node),backing=getComputedStyle(node,'::before');
    return{label:node.textContent.trim()||node.getAttribute('aria-label'),x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,filter:backing.backdropFilter,engine:node.dataset.glassEngine,geometryError:Math.max(...['left','right','top','bottom'].map(edge=>Math.abs(box[edge]-pane[edge]))),transform:getComputedStyle(node.querySelector('.topbarOriginalPane')).transform,textFilter:style.filter,border:style.borderTopWidth,shadow:style.boxShadow,hiddenRims:[...node.querySelectorAll('.topbarOriginalLayer > span')].every(n=>getComputedStyle(n).display==='none'),fill:backing.backgroundImage};
  }));
  assert.equal(initial.length,5,'all five visible header controls have the shared material');
  const passes=await controls.evaluateAll(nodes=>nodes.map(node=>{const id=getComputedStyle(node,'::before').backdropFilter.match(/#([^"\)]+)/)?.[1];return id?document.getElementById(id)?.children.length:0;}));
  assert.ok(passes.every(value=>value===2),'all header controls use the fast two-primitive optical pass');
  assert.ok(initial.every(x=>x.engine==='liquid-glass-react@1.1.1'&&x.filter.includes('url(')&&x.filter.includes('blur(8px)')),'real optical backdrop and blur, not a border-only treatment');
  assert.equal(new Set(initial.map(x=>x.filter)).size,5,'controls have separate filter IDs, without sampling another button');
  assert.ok(initial.every(x=>x.geometryError<1.25&&x.transform==='none'&&x.textFilter==='none'&&x.border==='0px'),'glass stays aligned and labels remain unfiltered');
  assert.ok(initial.every(x=>x.shadow==='none'&&x.hiddenRims),'no inset border, shadow outline or specular ring remains');
  assert.ok(initial.every(x=>x.x>=-1&&x.right<=page.viewportSize().width+1&&x.height>=24),'header buttons fit the viewport');
  const trigger=page.locator('.topbarPolicySelect .polishedSelectTrigger').first();
  const bounds=await trigger.boundingBox();
  await page.mouse.move(bounds.x+6,bounds.y+8);await page.mouse.move(bounds.x+bounds.width-7,bounds.y+12);
  await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.topbarPolicySelect .polishedSelectTrigger'),'::after').opacity)>.95,{},{timeout:6000});
  assert.equal(await trigger.locator('.topbarOriginalPane').evaluate(node=>getComputedStyle(node).transform),'none','quiet hover feedback never deforms the glass');
  await trigger.click();await page.getByRole('listbox').waitFor({state:'visible'});
  await page.screenshot({path:evidence+'/'+label+'-policy-menu.png'});
  await page.keyboard.press('Escape');await page.getByRole('listbox').waitFor({state:'detached'});
  await page.locator('.quotaButton').click();await page.getByRole('status',{name:'Codex 多账号额度详情'}).waitFor({state:'visible'});
  await page.locator('.quotaButton').click();await page.mouse.move(0,0);await page.getByRole('status',{name:'Codex 多账号额度详情'}).waitFor({state:'detached'});
  const toggle=page.locator('.rightWorkspaceToggle');const expanded=await toggle.getAttribute('aria-expanded');
  await toggle.click();assert.notEqual(await toggle.getAttribute('aria-expanded'),expanded);
  // The mobile right panel can cover the header toggle after its entrance.
  // Close through the existing global shortcut rather than racing the panel.
  await page.keyboard.press('Control+Shift+B');assert.equal(await toggle.getAttribute('aria-expanded'),expanded);
  await page.waitForTimeout(400);
  const warning=await page.locator('.trackedQuotaButton').evaluate(async node=>{const original=node.className,normal=getComputedStyle(node).color;node.classList.add('warning');await new Promise(resolve=>setTimeout(resolve,260));const color=getComputedStyle(node).color;node.className=original;return{normal,color};});
  assert.notEqual(warning.normal,warning.color,'warning state is not erased by the material');

  const saved=await trigger.evaluate(node=>{
    const result={style:node.style.cssText,labels:[...node.children].filter(n=>n.tagName==='SPAN'&&!n.classList.contains('composerGlassAnchor')).map(n=>({visibility:n.style.visibility}))};
    [...node.children].filter(n=>n.tagName==='SPAN'&&!n.classList.contains('composerGlassAnchor')).forEach(n=>n.style.visibility='hidden');
    node.style.setProperty('z-index','2','important');
    const pattern=document.createElement('div');pattern.className='qaTopbarPattern';pattern.style.cssText='position:absolute;inset:-16px;z-index:1;pointer-events:none;background:repeating-linear-gradient(90deg,#101010 0px,#101010 12px,#f8f8f8 12px,#f8f8f8 24px)';node.parentElement.append(pattern);return result;
  });
  const full=await trigger.screenshot({path:evidence+'/'+label+'-topbar-refraction.png'});
  await trigger.evaluate(node=>node.style.setProperty('--topbar-backdrop-optics','blur(8px) saturate(1.12)'));
  const blur=await trigger.screenshot({path:evidence+'/'+label+'-topbar-blur-only.png'});
  await trigger.evaluate(node=>node.style.setProperty('--topbar-backdrop-optics','none'));
  const sharp=await trigger.screenshot({path:evidence+'/'+label+'-topbar-no-blur.png'});
  const [f,b,s]=await Promise.all([pixels(full),pixels(blur),pixels(sharp)]);let delta=0,count=0,blurGradient=0,sharpGradient=0;
  for(let y=3;y<f.height-3;y++)for(let x=6;x<f.width-6;x++){const i=(y*f.width+x)*4;delta+=Math.abs(f.data[i]-b.data[i]);count++;blurGradient+=Math.abs(b.data[i]-b.data[i-4]);sharpGradient+=Math.abs(s.data[i]-s.data[i-4]);}
  const optical={meanDifference:delta/count,blurToSharpGradient:blurGradient/Math.max(1,sharpGradient)};
  assert.ok(optical.meanDifference>.3&&optical.blurToSharpGradient<.8,'topbar refraction and blur change actual background pixels: '+JSON.stringify(optical));
  await trigger.evaluate((node,saved)=>{node.style.cssText=saved.style;[...node.children].filter(n=>n.tagName==='SPAN'&&!n.classList.contains('composerGlassAnchor')).forEach((n,i)=>n.style.visibility=saved.labels[i].visibility);node.parentElement.querySelector('.qaTopbarPattern').remove();},saved);
  await page.screenshot({path:evidence+'/'+label+'-topbar-restored.png'});
  return{initial,warning,optical,policyMenu:true,quotaPopover:true,rightSidebarToggle:true};
}
