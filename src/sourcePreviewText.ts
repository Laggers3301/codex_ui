// Bound layout work, not file contents: Run/download still use the full source.
export function sourcePreviewText(source:string,maxCharacters=128*1024,maxLines=2000) {
  const end=Math.min(source.length,maxCharacters);let lines=1,cut=end;
  for(let i=0;i<end;i++)if(source.charCodeAt(i)===10&&++lines>maxLines){cut=i;break;}
  return {text:source.slice(0,cut),truncated:cut<source.length};
}
