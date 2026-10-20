import {describe,it,expect} from 'vitest';
import {sourcePreviewText} from './sourcePreviewText';
describe('source preview layout limits',()=>{
 it('preserves ordinary source exactly',()=>expect(sourcePreviewText('<!doctype html>\n你好')).toEqual({text:'<!doctype html>\n你好',truncated:false}));
 it('bounds long lines without modifying the source',()=>{const text='a'.repeat(200000);expect(sourcePreviewText(text).text.length).toBe(128*1024);expect(text.length).toBe(200000);});
 it('bounds line layout',()=>expect(sourcePreviewText('a\nb\nc',100,2)).toEqual({text:'a\nb',truncated:true}));
});
