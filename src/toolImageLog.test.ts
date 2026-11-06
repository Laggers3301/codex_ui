import {expect,it} from 'vitest';
import {readableToolImageLog} from './toolImageLog';
it('hides image encoding in full and deferred log previews without modifying original bytes',()=>{
  const data='/9j/'+ 'a'.repeat(1200),raw=JSON.stringify({type:'image',source:{type:'base64',media_type:'image/jpeg',data}});
  expect(readableToolImageLog(raw)).not.toContain(data);expect(readableToolImageLog(raw.slice(0,600))).toContain('图片编码已折叠');
  expect(JSON.parse(raw).source.data).toBe(data);
});
it('preserves non-image data and normal tool text',()=>{
  const raw=JSON.stringify({type:'text',data:'a'.repeat(1000)});expect(readableToolImageLog(raw)).toBe(raw);
});
