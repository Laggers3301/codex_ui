import {expect,it} from 'vitest';
import {defaultHtmlPreview} from './htmlFilePreview';
it('opens complete HTML/HTM files as rendered previews without changing source',()=>{
 const source='<!doctype html><html><body>你好</body></html>';
 expect(defaultHtmlPreview({name:'INDEX.HTML',kind:'text',truncated:false,content:source})).toEqual({kind:'html',title:'INDEX.HTML',source});
 expect(defaultHtmlPreview({name:'page.htm',kind:'text',truncated:false,content:source})?.source).toBe(source);
});
it('does not execute truncated files, other text, or binary content',()=>{
 for(const file of [{name:'a.html',kind:'text',truncated:true},{name:'a.txt',kind:'text',truncated:false},{name:'a.html',kind:'binary',truncated:false}])expect(defaultHtmlPreview({...file,content:'test'})).toBeNull();
});
