export function isHtmlPreviewFile(name:string) {return /\.html?$/i.test(name);}
export function defaultHtmlPreview(file:{name:string;kind:string;truncated:boolean;content?:string}) {
  return file.kind==='text'&&isHtmlPreviewFile(file.name)&&!file.truncated&&file.content
    ?{kind:'html' as const,title:file.name,source:file.content}:null;
}
