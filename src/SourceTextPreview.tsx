import {memo,useMemo} from 'react';
import {sourcePreviewText} from './sourcePreviewText';
export const SourceTextPreview=memo(function SourceTextPreview({source,name}:{source:string;name:string}){
  const visible=useMemo(()=>sourcePreviewText(source),[source]);
  return <>
    <pre className={`fileTextPreview${/\.html?$/i.test(name)?' fileHtmlSourcePreview':''}`}>{visible.text}</pre>
    {visible.truncated?<p className="previewHint">为保持页面流畅，仅展示前 2000 行／128K 字符源码；运行和下载仍使用完整内容。</p>:null}
  </>;
});
