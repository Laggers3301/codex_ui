/** Display-only: keep original image bytes in the tool result, not in the log DOM. */
export function readableToolImageLog(text:string):string {
  if(!text.includes('"image"')||!text.includes('"base64"'))return text;
  return text.replace(/("data"\s*:\s*")[A-Za-z0-9+/=]{256,}/g,'$1[图片编码已折叠，原始工具结果保留]');
}
