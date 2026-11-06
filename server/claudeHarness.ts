import fs from 'node:fs';
import path from 'node:path';
import type {Options} from '@anthropic-ai/claude-agent-sdk';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export function ownedClaudeFile(file:string,userId:string,cwd:string){
  const real=fs.realpathSync(file),roots=[fs.realpathSync(cwd),path.resolve('/tmp/codex_remote_uploads',userId)];
  if(!roots.some(root=>real.startsWith(root+path.sep)))throw Error('附件不在当前用户的工作区或上传目录。');
  return real;
}
export async function claudeOfficeText(file:string,userId:string,cwd:string,offset=0){
  const real=ownedClaudeFile(file,userId,cwd);
  if(path.extname(real).toLowerCase()!=='.docx'||!Number.isSafeInteger(offset)||offset<0)throw Error('需要DOCX文件和有效分页偏移。');
  if(fs.statSync(real).size>20*1024*1024)throw Error('DOCX超过20MiB，请先拆分文件。');
  const script=`import sys,zipfile,xml.etree.ElementTree as ET,json\np,o=sys.argv[1],int(sys.argv[2])\nwith zipfile.ZipFile(p) as z:\n info=z.getinfo('word/document.xml')\n if info.file_size>16*1024*1024: raise ValueError('DOCX XML too large')\n raw=z.read(info)\nroot=ET.fromstring(raw)\ntext='\\n'.join(''.join(p.itertext()) for p in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'))\nprint(json.dumps({'text':text[o:o+8000],'offset':o,'length':len(text),'nextOffset':o+8000 if o+8000<len(text) else None,'note':'正文文本提取，不代表图片、公式和版式已解析'},ensure_ascii=False))`;
  const result=await execute('/usr/bin/python3',['-c',script,real,String(offset)],{timeout:15000,maxBuffer:80*1024});
  return JSON.parse(result.stdout);
}

/** Only translate server-minted, thread-scoped services, never client MCP URLs. */
export function claudeWebMcp(config:Record<string,unknown>):NonNullable<Options['mcpServers']>{
  const result:NonNullable<Options['mcpServers']>={};
  for(const name of ['codex_browser','codex_schedules','codex_communication','codex_feishu']){
    const row=config[`mcp_servers.${name}`] as {url?:string;http_headers?:Record<string,string>;enabled?:boolean}|undefined;
    if(!row||row.enabled===false)continue;
    const url=new URL(row.url!);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/api/'))throw Error('Invalid scoped Claude MCP endpoint');
    result[name]={type:'http',url:url.href,headers:{...row.http_headers}};
  }
  return result;
}

export function claudeSkills(roots:string[]){
  const result:Array<{name:string;description:string;path:string;enabled:boolean}>=[],seen=new Set<string>();
  const visit=(folder:string,depth:number)=>{
    if(depth>5||result.length>=256)return;
    let real:string;try{real=fs.realpathSync(folder);}catch{return;}
    if(seen.has(real))return;seen.add(real);
    const file=path.join(real,'SKILL.md');
    if(fs.existsSync(file)){
      const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(8192);let size:number;
      try{size=fs.readSync(fd,buffer,0,buffer.length,0);}finally{fs.closeSync(fd);}
      const text=buffer.toString('utf8',0,size),name=text.match(/^name:\s*['"]?([^'"\r\n]+)['"]?\s*$/m)?.[1]??path.basename(real);
      result.push({name,description:text.match(/^description:\s*(.+)$/m)?.[1]??'',path:file,enabled:true});return;
    }
    let entries:fs.Dirent[];try{entries=fs.readdirSync(real,{withFileTypes:true});}catch{return;}
    for(const entry of entries)if(entry.isDirectory()||entry.isSymbolicLink())visit(path.join(real,entry.name),depth+1);
  };
  for(const root of roots)visit(root,0);
  return result;
}

/** Native byte input: never fetch arbitrary URLs on the web backend. */
export function claudeInput(parts:Array<Record<string,any>>,userId:string,cwd:string){
  if(parts.length>24||parts.filter(p=>!['text','skill'].includes(p.type)).length>8)throw Error('单次最多输入8个附件。');
  const text=parts.filter(p=>p.type==='text').map(p=>String(p.text??'')).join('\n');
  const skills=parts.filter(p=>p.type==='skill');
  const references=skills.map(p=>`技能 ${String(p.name)}：请按需先读取 ${JSON.stringify(p.path)} 的完整说明，再执行任务。`).join('\n');
  const prompt=[text,references].filter(Boolean).join('\n\n');
  const content:any[]=[{type:'text',text:prompt||'请查看所附内容。'}];
  let totalBytes=0;
  for(const part of parts){
    if(['text','skill'].includes(part.type))continue;
    if(part.type==='image'){
      const url=String(part.url??'');
      const data=url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/);
      if(data&&Buffer.byteLength(data[2],'base64')<=5*1024*1024){totalBytes+=Buffer.byteLength(data[2],'base64');if(totalBytes>20*1024*1024)throw Error('单次附件总大小上限20MiB。');content.push({type:'image',source:{type:'base64',media_type:data[1],data:data[2]}});continue;}
      throw Error('Claude 图片需要本地上传文件或不超过5MiB的图片数据。');
    }
    if(part.type!=='localImage'&&part.type!=='file')throw Error(`Claude 暂不支持输入类型 ${part.type}`);
    const file=ownedClaudeFile(String(part.path??''),userId,cwd);
    const size=fs.statSync(file).size;if(size>5*1024*1024)throw Error('Claude 单个直接输入附件上限为5MiB；大文件请通过文件工具分段读取。');
    totalBytes+=size;if(totalBytes>20*1024*1024)throw Error('单次附件总大小上限20MiB。');
    const ext=path.extname(file).toLowerCase(),media=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'} as Record<string,string>)[ext];
    if(media)content.push({type:'image',source:{type:'base64',media_type:media,data:fs.readFileSync(file).toString('base64')}});
    else if(ext==='.pdf')content.push({type:'document',source:{type:'base64',media_type:'application/pdf',data:fs.readFileSync(file).toString('base64')}});
    else content.push({type:'text',text:`用户附件路径：${JSON.stringify(file)}。请使用文件工具读取；无法解析时明确说明缺少的格式支持。`});
  }
  return {prompt:prompt||'请查看所附内容。',content:content.length>1?content:undefined};
}
