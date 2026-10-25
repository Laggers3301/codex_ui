import assert from 'node:assert/strict';
import {createCanvas,loadImage} from '@napi-rs/canvas';

async function pixels(buffer){
  const bitmap=await loadImage(buffer),canvas=createCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
  context.drawImage(bitmap,0,0);
  return {width:bitmap.width,height:bitmap.height,data:context.getImageData(0,0,bitmap.width,bitmap.height).data};
}

export async function verifyComposerGlassReadability(page,evidence,label){
  const composer=page.locator('.conversation > .composer');
  const opticalPasses=await composer.evaluate(root=>{const id=getComputedStyle(root,'::before').backdropFilter.match(/#([^"\)]+)/)?.[1];return id?document.getElementById(id)?.children.length:0;});
  assert.equal(opticalPasses,2,'the actual backdrop uses the fast two-primitive optical pass');
  const geometry=await composer.evaluate(async root=>{
    const originalStyle=root.style.cssText,pane=root.querySelector('.composerOriginalPane'),filter=root.querySelector('.composerOriginalPane filter');
    const samples=[];
    for(const height of [120,210,320,150]){
      root.style.setProperty('height',height+'px','important');
      root.style.setProperty('max-height','none','important');
      for(let frame=0;frame<5;frame++){
        await new Promise(requestAnimationFrame);
        const host=root.getBoundingClientRect();
        for(const surface of root.querySelectorAll('.composerOriginalPane,.composerOriginalPane .glass,.composerOriginalLayer > span')){
          const box=surface.getBoundingClientRect();
          samples.push({height,frame,kind:surface.className||surface.tagName,error:Math.max(...['left','right','top','bottom'].map(edge=>Math.abs(box[edge]-host[edge])))});
        }
      }
    }
    root.style.setProperty('height','auto','important');
    root.style.setProperty('max-height','65vh','important');
    const body=root.querySelector('.composerBody'),input=root.querySelector('.composerRichInput');
    const content=input.editor.getJSON();
    const header=document.createElement('div');header.className='qaGlassHeader';header.style.cssText='height:64px;flex:0 0 64px';header.textContent='子代理记录';
    const attachment=document.createElement('div');attachment.className='qaGlassAttachment';attachment.style.cssText='height:72px;flex:0 0 72px';attachment.textContent='图片附件缩略图区域';
    for(const scenario of ['newline','attachment','subagent']){
      if(scenario==='newline')input.editor.commands.setContent('<p>第一行</p><p>新增第二行</p><p>新增第三行</p>');
      if(scenario==='attachment')body.prepend(attachment);
      if(scenario==='subagent')root.insertBefore(header,body);
      for(let frame=0;frame<5;frame++){
        await new Promise(requestAnimationFrame);
        const host=root.getBoundingClientRect();
        for(const surface of root.querySelectorAll('.composerOriginalPane,.composerOriginalPane .glass,.composerOriginalLayer > span')){
          const box=surface.getBoundingClientRect();samples.push({scenario,frame,height:host.height,kind:surface.className||surface.tagName,error:Math.max(...['left','right','top','bottom'].map(edge=>Math.abs(box[edge]-host[edge])))});
        }
      }
    }
    header.remove();attachment.remove();input.editor.commands.setContent(content);
    root.style.cssText=originalStyle;
    return{samples,samePane:pane===root.querySelector('.composerOriginalPane'),sameFilter:filter===root.querySelector('.composerOriginalPane filter')};
  });
  assert.ok(geometry.samePane&&geometry.sameFilter,'typing/attachment/header resizing must not recreate optical surfaces');
  assert.ok(geometry.samples.every(sample=>sample.error<1.25),'all glass layers track size in the same frame: '+JSON.stringify(geometry.samples.filter(s=>s.error>=1.25)));

  const bounds=await composer.boundingBox();
  const before=await composer.evaluate(root=>({transform:getComputedStyle(root.querySelector('.composerOriginalPane')).transform,glint:root.querySelector('.composerOriginalLayer > span').style.backgroundImage}));
  await page.mouse.move(bounds.x+24,bounds.y+24);
  await page.mouse.move(bounds.x+bounds.width-28,bounds.y+36);
  await page.waitForFunction(previous=>document.querySelector('.composerOriginalLayer > span').style.backgroundImage!==previous,before.glint,{timeout:6000});
  const after=await composer.evaluate(root=>({transform:getComputedStyle(root.querySelector('.composerOriginalPane')).transform,glint:root.querySelector('.composerOriginalLayer > span').style.backgroundImage}));
  assert.equal(after.transform,'none','hover must never stretch or move the whole glass');
  assert.notEqual(before.glint,after.glint,'pointer-responsive highlights are retained');

  // A real, rendered background pattern, not just checking that a CSS URL is
  // attached. All content and style mutations are confined to the fixture tab.
  const original=await composer.evaluate(root=>{
    const saved={style:root.style.cssText,body:root.querySelector('.composerBody').style.visibility};
    root.style.setProperty('height','200px','important');root.style.setProperty('max-height','none','important');root.style.setProperty('z-index','2','important');
    root.querySelector('.composerBody').style.visibility='hidden';
    const pattern=document.createElement('div');pattern.className='qaGlassBackdrop';
    pattern.style.cssText='position:absolute;inset:0;z-index:1;pointer-events:none;background:repeating-linear-gradient(90deg,#101010 0px,#101010 28px,#f8f8f8 28px,#f8f8f8 56px)';
    root.parentElement.append(pattern);return saved;
  });
  await page.waitForTimeout(100);
  const full=await composer.screenshot({path:evidence+'/'+label+'-actual-refraction.png'});
  await composer.evaluate(root=>root.style.setProperty('--composer-backdrop-optics','blur(12px) saturate(1.12)'));
  const blur=await composer.screenshot({path:evidence+'/'+label+'-blur-only.png'});
  await composer.evaluate(root=>root.style.setProperty('--composer-backdrop-optics','none'));
  const sharp=await composer.screenshot({path:evidence+'/'+label+'-no-blur.png'});
  const [f,b,s]=await Promise.all([pixels(full),pixels(blur),pixels(sharp)]);
  let difference=0,changed=0,count=0,blurGradient=0,sharpGradient=0;
  for(let y=24;y<f.height-24;y++)for(let x=24;x<f.width-24;x++){
    const i=(y*f.width+x)*4;
    const delta=(Math.abs(f.data[i]-b.data[i])+Math.abs(f.data[i+1]-b.data[i+1])+Math.abs(f.data[i+2]-b.data[i+2]))/3;
    difference+=delta;if(delta>2)changed++;count++;
    blurGradient+=Math.abs(b.data[i]-b.data[i-4]);sharpGradient+=Math.abs(s.data[i]-s.data[i-4]);
  }
  const optical={meanDifference:difference/count,changedFraction:changed/count,blurToSharpGradient:blurGradient/Math.max(1,sharpGradient)};
  assert.ok(optical.meanDifference>.5&&optical.changedFraction>.02,'SVG backdrop refraction must change actual background pixels: '+JSON.stringify(optical));
  assert.ok(optical.blurToSharpGradient<.75,'blur must actually soften background edges: '+JSON.stringify(optical));
  await composer.evaluate((root,saved)=>{root.style.cssText=saved.style;root.querySelector('.composerBody').style.visibility=saved.body;root.parentElement.querySelector('.qaGlassBackdrop').remove();},original);
  await page.screenshot({path:evidence+'/'+label+'-restored-page.png'});
  await composer.screenshot({path:evidence+'/'+label+'-restored-composer.png'});
  return{geometry,hover:{before,after},optical};
}
